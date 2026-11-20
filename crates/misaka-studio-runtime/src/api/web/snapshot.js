(() => {
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]';
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility === 'visible' &&
      !element.closest('[inert],[aria-hidden=true]') && !element.matches(':disabled,[aria-disabled=true]');
  };
  const label = (element) => (
    element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') ||
    element.getAttribute('title') || element.getAttribute('name') || element.getAttribute('type') ||
    element.localName
  ).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
  const destination = (element) => element instanceof HTMLAnchorElement ? element.href : null;
  const handoff = (element) => element.matches('input,select,textarea,[contenteditable=true],button[type=submit],a[download],a[target=_blank]') ||
    (destination(element) !== null && !/^https?:/i.test(destination(element))) ||
    (element.matches('button') && element.form && element.type === 'submit') ||
    /\b(pay|purchase|buy|sell|checkout|submit|sign in|log in|confirm|delete|wallet|sign transaction)\b|購入|決済|支払|送信|削除|ログイン|署名/i.test(label(element));
  const controls = [...document.querySelectorAll(selector)].filter(visible).slice(0, 30);
  const url = location.href;
  globalThis.misakaClick = (index, expectedUrl, expectedLabel, expectedDestination) => {
    const element = controls[index];
    if (location.href !== expectedUrl || !element?.isConnected || !visible(element) ||
        handoff(element) || label(element) !== expectedLabel || destination(element) !== expectedDestination) return false;
    element.click();
    return true;
  };
  return {
    url,
    title: document.title.slice(0, 200),
    text: (document.querySelector('main') || document.body)?.innerText.trim().slice(0, 14000) || '',
    controls: controls.map((element) => ({label: label(element), destination: destination(element), handoff: Boolean(handoff(element))})),
  };
})()
