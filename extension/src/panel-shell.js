(function installPanelShell(global) {
  "use strict";
  const PANEL_WIDTH = 438;
  const VIEWPORT_GAP = 8;
  const DEFAULT_OFFSET = 24;
  function applyStyles(element, declarations) {
    element.style.cssText = declarations.join(";");
    return element;
  }

  function button(id, label, primary) {
    const element = document.createElement("button");
    element.id = id;
    element.type = "button";
    element.textContent = label;
    applyStyles(element, [
      `border:1px solid ${primary ? "#555" : "#333"}`,
      `background:${primary ? "#fff" : "#1a1a1a"}`,
      `color:${primary ? "#000" : "#bbb"}`,
      "border-radius:6px",
      "padding:0 11px",
      "height:32px",
      "font-size:11px",
      `font-weight:${primary ? "500" : "400"}`,
      "cursor:pointer",
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "flex:0 0 auto",
      "white-space:nowrap",
      "box-sizing:border-box",
      "font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "transition:opacity .15s"
    ]);
    element.addEventListener("mouseenter", () => { element.style.opacity = ".85"; });
    element.addEventListener("mouseleave", () => { element.style.opacity = "1"; });
    return element;
  }


  function create({id, prefix, name, label = name, version: runtimeVersion}) {
    let hidden = true;
    let manuallyPositioned = false;
    let locked = false;
  const panel = applyStyles(document.createElement("aside"), [
    "position:fixed",
    "top:24px",
    "right:24px",
    `width:min(${PANEL_WIDTH}px,calc(100vw - 32px))`,
    "height:auto",
    `min-width:min(${PANEL_WIDTH}px,calc(100vw - 32px))`,
    "min-height:0",
    "max-height:calc(100vh - 16px)",
    "background:#0d0d0d",
    "border:1px solid #222",
    "border-radius:12px",
    "z-index:2147483647",
    "display:none",
    "flex-direction:column",
    "font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 18px 50px rgba(0,0,0,.45)",
    "color:#e5e5e5",
    "overflow:hidden",
    "box-sizing:border-box"
  ]);
  panel.id = id;
  panel.dataset.extensionVersion = runtimeVersion;
  panel.setAttribute("aria-label", label);
  panel.tabIndex = -1;
  const backdrop = applyStyles(document.createElement("div"), [
    "position:fixed", "inset:0", "z-index:2147483646", "display:none",
    "background:rgba(0,0,0,.28)", "cursor:wait", "touch-action:none"
  ]);
  backdrop.id = `${prefix}-page-lock`;
  backdrop.setAttribute("aria-hidden", "true");
  const guardedEvents = ["pointerdown", "pointerup", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchmove", "keydown", "keyup", "keypress", "beforeinput", "focusin"];
  function guardPage(event) {
    if (!locked || !event.isTrusted) return;
    if (event.composedPath().includes(panel)) {
      const editable = event.target.closest?.("input,select,textarea,[contenteditable='true']");
      const activation = event.key === " " && event.target.closest?.("button");
      if (event.type === "keydown" && !editable && !activation && [" ","ArrowUp","ArrowDown","PageUp","PageDown","Home","End"].includes(event.key)) event.preventDefault();
      if (event.type === "wheel") {
        let target = event.target;
        let canScroll = false;
        while (target && panel.contains(target)) {
          const overflow = getComputedStyle(target).overflowY;
          if (/(auto|scroll)/.test(overflow) && (event.deltaY < 0 ? target.scrollTop > 0 : target.scrollTop + target.clientHeight < target.scrollHeight)) { canScroll = true; break; }
          target = target.parentElement;
        }
        if (!canScroll) event.preventDefault();
      }
      return;
    }
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "focusin") panel.focus({preventScroll:true});
  }
  for (const type of guardedEvents) document.addEventListener(type, guardPage, {capture:true, passive:false});
  function setLocked(value) {
    locked = Boolean(value);
    backdrop.style.display = locked ? "block" : "none";
    if (locked) {
      setHidden(false);
      if (!panel.contains(document.activeElement)) panel.focus({preventScroll:true});
    }
  }

  const header = applyStyles(document.createElement("div"), [
    "display:flex", "align-items:center", "justify-content:space-between", "gap:8px",
    "padding:8px 10px", "border-bottom:1px solid #1a1a1a", "background:#111",
    "min-height:40px", "cursor:move", "user-select:none", "box-sizing:border-box"
  ]);
  header.id = `${prefix}-drag-handle`;
  header.title = "Drag to move";
  const title = document.createElement("div");
  title.id = `${prefix}-title`;
  title.textContent = name;
  title.title = label;
  title.style.cssText = "font-size:12px;font-weight:500;color:#e5e5e5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  const version = document.createElement("div");
  version.id = `${prefix}-version`;
  version.textContent = `by aipieksel · v${runtimeVersion}`;
  version.style.cssText = "font-size:10px;color:#555;white-space:nowrap;";
  header.append(title, version);

  const body = applyStyles(document.createElement("div"), [
    "display:flex", "flex-direction:column", "flex:0 1 auto", "min-height:0", "overflow:hidden",
    "background:#0d0d0d", "position:relative"
  ]);


    panel.append(header, body);
  function resizeHandle(corner, position, cursor, angle) {
    const element = document.createElement("div");
    element.id = `${prefix}-resize-handle-${corner}`;
    element.title = `Resize panel from ${corner.replace("-", " ")}`;
    element.setAttribute("aria-label", element.title);
    Object.assign(element.style, position, {
      position: "absolute", width: "18px", height: "18px", cursor, zIndex: "4", opacity: ".9",
      touchAction: "none", background: `linear-gradient(${angle}deg,transparent 0 48%,rgba(255,255,255,.22) 49% 54%,transparent 55% 100%)`
    });
    panel.appendChild(element);
    makeResizable(element, corner);
  }

  function clamp(value, min, max) { return Math.min(Math.max(Number(value) || 0, min), max); }
  function minimumWidth() { return Math.min(PANEL_WIDTH, Math.max(180, innerWidth - VIEWPORT_GAP * 2)); }
  function minimumHeight() { return Math.min(320, Math.max(220, innerHeight - VIEWPORT_GAP * 2)); }

  function clampToViewport() {
    if (hidden) return;
    const rect = panel.getBoundingClientRect();
    if (!manuallyPositioned) {
      panel.style.left = "auto";
      panel.style.right = `${innerWidth < 380 ? VIEWPORT_GAP : DEFAULT_OFFSET}px`;
      panel.style.top = `${clamp(rect.top, VIEWPORT_GAP, Math.max(VIEWPORT_GAP, innerHeight - VIEWPORT_GAP - rect.height))}px`;
      return;
    }
    const width = Math.min(rect.width, innerWidth - VIEWPORT_GAP * 2);
    const height = Math.min(rect.height, innerHeight - VIEWPORT_GAP * 2);
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.left = `${clamp(rect.left, VIEWPORT_GAP, innerWidth - VIEWPORT_GAP - width)}px`;
    panel.style.top = `${clamp(rect.top, VIEWPORT_GAP, innerHeight - VIEWPORT_GAP - height)}px`;
    panel.style.right = "auto";
  }

  function pointerSession(handleElement, onMove, onEnd) {
    return (event) => {
      if (event.button !== 0) return;
      const move = (moveEvent) => { moveEvent.preventDefault(); onMove(moveEvent); };
      const end = (endEvent) => {
        try { handleElement.releasePointerCapture(endEvent.pointerId); } catch (_) {}
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", end, true);
        document.removeEventListener("pointercancel", end, true);
        body.style.pointerEvents = previousPointerEvents;
        clampToViewport();
        if (onEnd) onEnd();
      };
      event.preventDefault();
      const previousPointerEvents = body.style.pointerEvents;
      body.style.pointerEvents = "none";
      try { handleElement.setPointerCapture(event.pointerId); } catch (_) {}
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", end, true);
      document.addEventListener("pointercancel", end, true);
    };
  }

  header.addEventListener("pointerdown", function (event) {
    if (event.target.closest("button,input,select,textarea,a")) return;
    const start = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    manuallyPositioned = true;
    panel.style.left = `${start.left}px`;
    panel.style.top = `${start.top}px`;
    panel.style.right = "auto";
    pointerSession(header, (move) => {
      panel.style.left = `${clamp(start.left + move.clientX - startX, 0, innerWidth - start.width)}px`;
      panel.style.top = `${clamp(start.top + move.clientY - startY, 0, innerHeight - start.height)}px`;
    })(event);
  });

  function makeResizable(handleElement, corner) {
    handleElement.addEventListener("pointerdown", function (event) {
      const start = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const fromLeft = corner.includes("left");
      const fromTop = corner.includes("top");
      manuallyPositioned = true;
      panel.style.left = `${start.left}px`;
      panel.style.top = `${start.top}px`;
      panel.style.right = "auto";
      pointerSession(handleElement, (move) => {
        const width = clamp(start.width + (fromLeft ? startX - move.clientX : move.clientX - startX), minimumWidth(), innerWidth - VIEWPORT_GAP * 2);
        const height = clamp(start.height + (fromTop ? startY - move.clientY : move.clientY - startY), minimumHeight(), innerHeight - VIEWPORT_GAP * 2);
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
        panel.style.left = `${fromLeft ? start.right - width : start.left}px`;
        panel.style.top = `${fromTop ? start.bottom - height : start.top}px`;
      })(event);
      event.stopPropagation();
    });
  }

  resizeHandle("top-left", { left: "0", top: "0" }, "nwse-resize", 315);
  resizeHandle("top-right", { right: "0", top: "0" }, "nesw-resize", 45);
  resizeHandle("bottom-left", { left: "0", bottom: "0" }, "nesw-resize", 225);
  resizeHandle("bottom-right", { right: "0", bottom: "0" }, "nwse-resize", 135);

  function setHidden(value) {
    if (value && locked) return;
    hidden = Boolean(value);
    panel.style.display = hidden ? "none" : "flex";
    if (!hidden) clampToViewport();
  }


    global.addEventListener("resize", clampToViewport);
    (document.body || document.documentElement).append(backdrop, panel);
    return {
      panel, header, body, button, setHidden, setLocked, clampToViewport,
      get locked() { return locked; },
      get hidden() { return hidden; },
      get manuallyPositioned() { return manuallyPositioned; },
      destroy() {
        setLocked(false);
        for (const type of guardedEvents) document.removeEventListener(type, guardPage, true);
        global.removeEventListener("resize", clampToViewport); backdrop.remove(); panel.remove();
      }
    };
  }
  global.AipiekselPanel = {create, button};
})(globalThis);
