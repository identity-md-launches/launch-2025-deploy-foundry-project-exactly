// Small shared UI: toasts (transaction progress and notices) and a modal dialog.

type Kind = "" | "ok" | "bad" | "wait";
export interface Toast {
  update(msg: string, kind?: Kind, ms?: number, link?: string): void;
  close(): void;
}

/** Decorative shared loader; its text label belongs to the surrounding UI. */
export function partsLoader(): HTMLElement {
  const el = document.createElement("i");
  el.className = "parts-loader";
  el.setAttribute("aria-hidden", "true");
  return el;
}

function stack() {
  let s = document.getElementById("toasts");
  if (!s) {
    s = document.createElement("div");
    s.id = "toasts";
    s.setAttribute("role", "status");
    s.setAttribute("aria-live", "polite");
    document.body.appendChild(s);
  }
  return s;
}

/** a notice in the corner; ms = 0 keeps it until updated or closed */
export function toast(msg: string, kind: Kind = "", ms = 4000, link = ""): Toast {
  const el = document.createElement("div");
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.classList.add("out");
    setTimeout(() => el.remove(), 200);
  };
  const update = (m: string, k: Kind = "", t = 4000, l = "") => {
    el.className = "toast " + k;
    el.innerHTML = "";
    if (k === "wait") el.appendChild(partsLoader());
    el.appendChild(Object.assign(document.createElement("span"), { textContent: m }));
    if (l) el.appendChild(Object.assign(document.createElement("a"), { href: l, target: "_blank", rel: "noopener", textContent: "View ↗" }));
    const x = Object.assign(document.createElement("button"), { className: "x", textContent: "×", title: "Dismiss" });
    x.setAttribute("aria-label", "Dismiss");
    x.onclick = close;
    el.appendChild(x);
    clearTimeout(timer);
    if (t) timer = window.setTimeout(close, t);
  };
  update(msg, kind, ms, link);
  const st = stack();
  st.appendChild(el);
  // keep it to a few: the oldest finished ones make room
  const done = [...st.children].filter((c) => !c.classList.contains("wait") && c !== el);
  while (st.children.length > 4 && done.length) done.shift()!.remove();
  return { update, close };
}

/** a modal with a title and body; returns the dialog and a close function. Esc and the backdrop close it. */
export function modal(title: string, body: HTMLElement | string, onClose?: () => void) {
  const d = document.createElement("dialog");
  d.className = "modal";
  d.setAttribute("aria-label", title);
  const head = document.createElement("div");
  head.className = "modal-head";
  head.innerHTML = `<h3></h3><button class="x" aria-label="Close" title="Close">×</button>`;
  head.querySelector("h3")!.textContent = title;
  d.appendChild(head);
  const content = document.createElement("div");
  content.className = "modal-body";
  if (typeof body === "string") content.innerHTML = body;
  else content.appendChild(body);
  d.appendChild(content);
  document.body.appendChild(d);
  const close = () => d.close();
  d.addEventListener("close", () => {
    d.remove();
    onClose?.();
  });
  head.querySelector("button")!.addEventListener("click", close);
  d.addEventListener("click", (e) => e.target === d && close());
  d.showModal();
  return { dialog: d, close, body: content };
}
