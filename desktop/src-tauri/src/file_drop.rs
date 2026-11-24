//! Deliver OS drops to the UI. Only dropped files can be read through this channel.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{cell::Cell, fs::File, io::Read, path::Path};
use tauri::{DragDropEvent, PhysicalPosition, WebviewWindow, WindowEvent};

// Keep one extra byte so the composer's UTF-8 decoder can detect truncation.
const TEXT_BYTES: u64 = 200 * 1024 + 1;
const IMAGE_BATCH_BYTES: u64 = 32 * 1024 * 1024;

struct DropWindow {
    window: WebviewWindow,
    origin: String,
}

impl DropWindow {
    fn script(&self, detail: Value) -> String {
        format!(
            "(() => {{ if (location.origin !== {}) return null; const detail = {}; \
             window.dispatchEvent(new CustomEvent('misaka-desktop-drop', {{ detail }})); \
             return detail.read ?? null; }})()",
            self.origin, detail
        )
    }

    fn emit(&self, detail: Value) {
        let _ = self.window.eval(self.script(detail));
    }

    fn point(&self, position: &PhysicalPosition<f64>) -> [f64; 2] {
        // Wry's macOS and GTK handlers already report points. WebView2 reports device pixels.
        let scale = if cfg!(windows) { self.window.scale_factor().unwrap_or(1.0) } else { 1.0 };
        [position.x / scale, position.y / scale]
    }
}

pub fn listen(window: &WebviewWindow, origin: &str) {
    let target = DropWindow { window: window.clone(), origin: json!(origin).to_string() };
    let active = Cell::new(false);
    let sequence = Cell::new(0u64);
    window.on_window_event(move |event| {
        let WindowEvent::DragDrop(event) = event else { return };
        match event {
            DragDropEvent::Enter { paths, position } if !paths.is_empty() => {
                active.set(true);
                target.emit(json!({ "type": "hover", "point": target.point(position) }));
            }
            DragDropEvent::Over { position } if active.get() => {
                target.emit(json!({ "type": "hover", "point": target.point(position) }));
            }
            DragDropEvent::Leave => {
                if active.replace(false) {
                    target.emit(json!({ "type": "leave" }));
                }
            }
            DragDropEvent::Drop { paths, position } => {
                if paths.is_empty() {
                    if active.replace(false) {
                        target.emit(json!({ "type": "leave" }));
                    }
                    return;
                }
                active.set(false);
                let id = sequence.get() + 1;
                sequence.set(id);
                let names: Vec<_> = paths.iter().map(|path| path.to_str()).collect();
                let script = target.script(json!({ "type": "drop", "point": target.point(position), "id": id, "paths": names }));
                let window = target.window.clone();
                let origin = target.origin.clone();
                let paths = paths.clone();
                let _ = target.window.eval_with_callback(script, move |result| {
                    let image = match result.as_str() {
                        "\"text\"" => false,
                        "\"image\"" => true,
                        _ => return,
                    };
                    let target = DropWindow { window: window.clone(), origin: origin.clone() };
                    let paths = paths.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let mut remaining = IMAGE_BATCH_BYTES;
                        let files: Vec<_> = paths.iter().map(|path| read_file(path, image, &mut remaining)).collect();
                        target.emit(json!({ "type": "files", "id": id, "files": files }));
                    });
                });
            }
            _ => {}
        }
    });
}

fn read_file(path: &Path, image: bool, remaining: &mut u64) -> Value {
    let name = path.file_name().unwrap_or(path.as_os_str()).to_string_lossy();
    let mime = mime_guess::from_path(path).first_raw().unwrap_or("");
    let read = || -> Result<(u64, Vec<u8>), String> {
        let metadata = path.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Select a file to attach.".into());
        }
        if image && !mime.starts_with("image/") {
            return Err("Only image files can be added as references.".into());
        }
        let limit = if image { *remaining } else { TEXT_BYTES };
        if image && metadata.len() > limit {
            return Err("Dropped reference images exceed 32 MB in total.".into());
        }
        let mut bytes = Vec::new();
        let file = File::open(path).map_err(|error| error.to_string())?;
        file.take(limit + u64::from(image)).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if image && bytes.len() as u64 > limit {
            return Err("Dropped reference images exceed 32 MB in total.".into());
        }
        Ok((metadata.len(), bytes))
    };
    match read() {
        Ok((size, bytes)) => {
            if image {
                *remaining -= bytes.len() as u64;
            }
            json!({ "name": name, "size": size, "mime": mime, "base64": STANDARD.encode(bytes) })
        }
        Err(reason) => json!({ "name": name, "error": reason }),
    }
}
