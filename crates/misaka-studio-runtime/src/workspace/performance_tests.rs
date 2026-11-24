//! Regression checks for the amount of filesystem/Git work, without wall-clock speed claims.

use super::*;

fn opened() -> (tempfile::TempDir, Workspace) {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(directory.path().to_str().unwrap()).unwrap();
    (directory, workspace)
}

fn put(workspace: &Workspace, path: &str, text: &str) {
    let target = workspace.root().join(path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, text).unwrap();
}

#[test]
fn interactive_queries_share_an_index_but_fresh_calls_and_mutations_invalidate_it() {
    let (_directory, workspace) = opened();
    put(&workspace, "src/main.rs", "main\n");
    put(&workspace, "src/model.rs", "model\n");
    assert_eq!(files_cached(&workspace, "", None).unwrap().paths.len(), 2);
    assert_eq!(files_cached(&workspace, "main", None).unwrap().paths, ["src/main.rs"]);
    assert_eq!(files_cached(&workspace, "model", None).unwrap().paths, ["src/model.rs"]);
    assert_eq!(workspace.io_stats.file_walks.load(Ordering::Relaxed), 1, "typing only scores the existing index");

    // External changes may wait for the two-second TTL; a fresh/tool request always sees them.
    put(&workspace, "external.txt", "new\n");
    assert!(files_cached(&workspace, "external", None).unwrap().paths.is_empty());
    assert_eq!(files(&workspace, "external", None).unwrap().paths, ["external.txt"]);
    assert_eq!(files_cached(&workspace, "external", None).unwrap().paths, ["external.txt"]);

    write(&workspace, ".ignore", "external.txt\n".to_string()).unwrap();
    assert!(files_cached(&workspace, "external", None).unwrap().paths.is_empty(), "own ignore edits invalidate cached paths");
    write(&workspace, "created.txt", "old\n".to_string()).unwrap();
    assert_eq!(files_cached(&workspace, "created", None).unwrap().paths, ["created.txt"]);
    remove(&workspace, "created.txt").unwrap();
    assert!(files_cached(&workspace, "created", None).unwrap().paths.is_empty());

    put(&workspace, "after-ttl.txt", "later");
    let slot = file_index_slot(workspace.root());
    {
        let mut state = slot.state.lock().unwrap();
        Arc::get_mut(state.index.as_mut().unwrap()).unwrap().built = Instant::now() - FILE_INDEX_TTL;
    }
    assert_eq!(
        files_cached(&workspace, "afterttl", None).unwrap().paths,
        ["after-ttl.txt"],
        "external changes become visible after expiry"
    );
}

#[test]
fn concurrent_interactive_queries_do_one_walk_per_root() {
    let (_directory, workspace) = opened();
    for number in 0..500 {
        put(&workspace, &format!("src/file-{number:04}.rs"), "");
    }
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = ["file", "rs"]
        .into_iter()
        .map(|query| {
            let workspace = workspace.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                files_cached(&workspace, query, Some(10)).unwrap().paths
            })
        })
        .collect();
    barrier.wait();
    for thread in threads {
        assert_eq!(thread.join().unwrap().len(), 10);
    }
    assert_eq!(workspace.io_stats.file_walks.load(Ordering::Relaxed), 1);
}

#[test]
fn cancelled_queries_stop_even_while_waiting_for_an_existing_index_build() {
    let (_directory, workspace) = opened();
    let slot = file_index_slot(workspace.root());
    slot.state.lock().unwrap().loading = true;
    let cancellation = Cancellation::default();
    let cancelled_workspace = workspace.with_cancellation(cancellation.clone());
    let waiter = std::thread::spawn(move || files_cached(&cancelled_workspace, "a", None));
    cancellation.cancel();
    assert!(matches!(waiter.join().unwrap(), Err(Error::Cancelled)));
    slot.state.lock().unwrap().loading = false;
    slot.ready.notify_all();
}

#[test]
fn tree_only_stats_files_in_the_returned_window() {
    let (_directory, workspace) = opened();
    for number in 0..400 {
        put(&workspace, &format!("file-{number:04}.txt"), "text");
    }
    let listing = tree(&workspace, None, Some(1), Some(7)).unwrap();
    assert!(listing.truncated);
    assert_eq!(listing.entries.len(), 7);
    assert_eq!(listing.entries[0].path, "file-0000.txt");
    assert_eq!(listing.entries[6].path, "file-0006.txt");
    assert!(listing.entries.iter().all(|entry| entry.size == Some(4)));
    assert_eq!(workspace.io_stats.tree_file_stats.load(Ordering::Relaxed), 7, "discarded ordinary files need no size stat");
}

#[test]
fn repeated_ranges_seek_to_sparse_offsets_without_rescanning_to_eof() {
    let (_directory, workspace) = opened();
    let text: String = (1..=150_000).map(|line| format!("line {line:06}\n")).collect();
    put(&workspace, "large.txt", &text);
    let first = read(&workspace, "large.txt", Some(1), Some(2), None).unwrap();
    let cold_chunks = workspace.io_stats.read_chunks.swap(0, Ordering::Relaxed);
    assert_eq!(first.content, "line 000001\nline 000002\n");
    assert_eq!(first.total_lines, 150_000);
    assert!(cold_chunks > 20);
    let middle = read(&workspace, "large.txt", Some(100_000), Some(100_002), None).unwrap();
    let warm_chunks = workspace.io_stats.read_chunks.load(Ordering::Relaxed);
    assert_eq!(middle.content, "line 100000\nline 100001\nline 100002\n");
    assert_eq!((middle.start_line, middle.end_line, middle.total_lines), (100_000, 100_002, 150_000));
    assert!(!middle.truncated);
    assert_eq!(warm_chunks, 1, "a warm short range visits one buffered chunk, not the rest of the file");
    eprintln!("workspace read chunks: cold={cold_chunks}, warm={warm_chunks}, exact total_lines={}", middle.total_lines);
    let capped = read(&workspace, "large.txt", None, None, Some(14)).unwrap();
    assert_eq!(capped.content, "line 000001\n");
    assert!(capped.truncated);
    assert_eq!(capped.total_lines, 150_000);
    write(&workspace, "other.txt", "unrelated save".into()).unwrap();
    workspace.io_stats.read_chunks.store(0, Ordering::Relaxed);
    read(&workspace, "large.txt", Some(100_000), Some(100_002), None).unwrap();
    assert_eq!(workspace.io_stats.read_chunks.load(Ordering::Relaxed), 1, "saving another file keeps this version's line index warm");
}

#[test]
fn file_replacement_and_own_edits_invalidate_line_offsets() {
    let (_directory, workspace) = opened();
    put(&workspace, "same.txt", "a\nb");
    assert_eq!(read(&workspace, "same.txt", None, None, None).unwrap().total_lines, 2);
    let modified = std::fs::metadata(workspace.root().join("same.txt")).unwrap().modified().unwrap();
    put(&workspace, "replacement.txt", "abc");
    let replacement = std::fs::File::options().write(true).open(workspace.root().join("replacement.txt")).unwrap();
    replacement.set_modified(modified).unwrap();
    drop(replacement);
    std::fs::rename(workspace.root().join("replacement.txt"), workspace.root().join("same.txt")).unwrap();
    let current = read(&workspace, "same.txt", None, None, None).unwrap();
    assert_eq!((current.total_lines, current.content.as_str()), (1, "abc"));
    edit(&workspace, "same.txt", "abc", "a\nb", false).unwrap();
    assert_eq!(read(&workspace, "same.txt", None, None, None).unwrap().total_lines, 2);
    std::fs::write(workspace.root().join("same.txt"), b"a\0b").unwrap();
    assert!(
        read(&workspace, "same.txt", None, None, None).unwrap().binary,
        "a changed file is sniffed again even if it had a text index"
    );
}

#[cfg(unix)]
#[test]
fn a_cached_read_does_not_bypass_the_symlink_boundary_check() {
    let (_directory, workspace) = opened();
    let (outside, _) = opened();
    put(&workspace, "file.txt", "inside\n");
    read(&workspace, "file.txt", None, None, None).unwrap();
    std::fs::write(outside.path().join("secret.txt"), "outside\n").unwrap();
    std::fs::remove_file(workspace.root().join("file.txt")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), workspace.root().join("file.txt")).unwrap();
    let error = read(&workspace, "file.txt", None, None, None).unwrap_err();
    assert!(error.to_string().contains("escapes the workspace"));
}

#[test]
fn line_checkpoints_remain_bounded_for_very_many_short_lines() {
    let mut builder = LineIndexBuilder::new();
    let last = LINE_INDEX_CHECKPOINTS * LINE_INDEX_STRIDE * 4;
    for line in (1 + LINE_INDEX_STRIDE..=last).step_by(LINE_INDEX_STRIDE) {
        builder.newline(line, line as u64 - 1);
    }
    assert!(builder.checkpoints.len() <= LINE_INDEX_CHECKPOINTS);
    assert_eq!(builder.checkpoints[0], (1, 0));
    assert!(builder.checkpoints.last().unwrap().0 > last / 2, "the bounded index still covers the whole file");
}

#[test]
fn cancelled_read_only_operations_touch_no_file_content() {
    let (_directory, workspace) = opened();
    put(&workspace, "a.txt", "text");
    let cancellation = Cancellation::default();
    cancellation.cancel();
    let workspace = workspace.with_cancellation(cancellation);
    assert!(matches!(tree(&workspace, None, None, None), Err(Error::Cancelled)));
    assert!(matches!(files(&workspace, "a", None), Err(Error::Cancelled)));
    assert!(matches!(read(&workspace, "a.txt", None, None, None), Err(Error::Cancelled)));
    assert!(matches!(
        search(&workspace, &SearchRequest { pattern: "text".into(), ..SearchRequest::default() }),
        Err(Error::Cancelled)
    ));
    assert_eq!(workspace.io_stats.read_chunks.load(Ordering::Relaxed), 0);
    assert_eq!(workspace.io_stats.file_walks.load(Ordering::Relaxed), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn completed_and_failed_commands_invalidate_interactive_indexes() {
    let (_directory, workspace) = opened();
    assert!(files_cached(&workspace, "created", None).unwrap().paths.is_empty());
    let output = exec(&workspace, "printf 'new\\n' > created.txt; exit 1", Some(5)).await.unwrap();
    assert_eq!(output.exit_code, Some(1));
    assert_eq!(files_cached(&workspace, "created", None).unwrap().paths, ["created.txt"]);
}

fn setup_git(workspace: &Workspace, args: &[&str]) {
    let result = std::process::Command::new("git")
        .current_dir(workspace.root())
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(result.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&result.stderr));
}

#[tokio::test]
async fn background_git_status_skips_numstat_and_untracked_content_but_detailed_status_keeps_counts() {
    if !std::process::Command::new("git").arg("--version").output().is_ok_and(|output| output.status.success()) {
        eprintln!("git is not installed; skipping real-git work-count check");
        return;
    }
    let (_directory, workspace) = opened();
    setup_git(&workspace, &["init", "-q"]);
    put(&workspace, "tracked.txt", "one\ntwo\nthree\n");
    put(&workspace, "old.txt", "rename\nthese\nlines\n");
    setup_git(&workspace, &["add", "."]);
    setup_git(&workspace, &["commit", "-qm", "initial"]);
    put(&workspace, "tracked.txt", "one\nchanged\nthree\n");
    put(&workspace, "new-one.txt", "a\nb\n");
    put(&workspace, "new-two.txt", "c\n");

    let summary = git::status_with_counts(&workspace, false).await.unwrap();
    assert_eq!(summary.counts_included, Some(false));
    assert_eq!(summary.files.len(), 3);
    assert!(summary.files.iter().all(|file| file.added.is_none() && file.removed.is_none()));
    let summary_commands = workspace.io_stats.git_commands.lock().unwrap().clone();
    assert_eq!(summary_commands.len(), 2, "only repository prefix and porcelain status");
    assert!(!summary_commands.iter().flatten().any(|arg| arg == "--numstat"));
    assert_eq!(workspace.io_stats.git_count_visits.load(Ordering::Relaxed), 0);

    workspace.io_stats.git_commands.lock().unwrap().clear();
    let detailed = git::status(&workspace).await.unwrap();
    assert_eq!(detailed.counts_included, None);
    assert_eq!((detailed.added, detailed.removed), (4, 1));
    assert_eq!(workspace.io_stats.git_count_visits.load(Ordering::Relaxed), 2);
    assert!(workspace.io_stats.git_commands.lock().unwrap().iter().flatten().any(|arg| arg == "--numstat"));
    assert!(serde_json::to_value(&detailed).unwrap().get("counts_included").is_none(), "the existing full JSON contract is unchanged");

    // There is no status-result TTL: an external edit is visible on the next request.
    put(&workspace, "tracked.txt", "one\nchanged\nthree\nfour\n");
    assert_eq!(git::status(&workspace).await.unwrap().added, 5);

    workspace.io_stats.git_commands.lock().unwrap().clear();
    let patch = git::diff(&workspace, Some("tracked.txt")).await.unwrap();
    assert!(patch.patch.contains("+changed"));
    let calls = workspace.io_stats.git_commands.lock().unwrap().clone();
    let statuses: Vec<_> = calls.iter().filter(|args| args[0] == "status").collect();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].last().unwrap(), "tracked.txt", "one-file diff scopes the expensive status traversal");

    setup_git(&workspace, &["mv", "old.txt", "renamed.txt"]);
    workspace.io_stats.git_commands.lock().unwrap().clear();
    let renamed = git::diff(&workspace, Some("renamed.txt")).await.unwrap();
    assert!(renamed.patch.contains("rename from old.txt"));
    assert!(renamed.patch.contains("rename to renamed.txt"));
    let calls = workspace.io_stats.git_commands.lock().unwrap().clone();
    let statuses: Vec<_> = calls.iter().filter(|args| args[0] == "status").collect();
    assert_eq!(statuses.len(), 2, "an A/D at the boundary needs the full listing to recover its rename");
    assert_eq!(statuses[1].last().unwrap(), ".");
}
