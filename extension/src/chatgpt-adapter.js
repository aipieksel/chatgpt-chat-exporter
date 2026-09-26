(function initializeChatGPTAdapter(global) {
  "use strict";

  const api = global.ChatGPTExporter = global.ChatGPTExporter || {};
  let cancellationRequested = false;

  function turnSections() {
    return Array.from(document.querySelectorAll("section[data-turn], section[data-testid^='conversation-turn-']"))
      .filter((section) => Number.isInteger(api.parseTurnNumber(section)));
  }

  function findScrollRoot(sections) {
    const scored = [];
    const add = (element, score) => {
      if (!element || scored.some((item) => item.element === element)) return;
      const style = getComputedStyle(element);
      const scrollable = element.scrollHeight > element.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY || "");
      if (scrollable) scored.push({ element, score });
    };
    add(document.querySelector("main#main"), 100);
    add(document.querySelector("main"), 80);
    for (const section of sections) {
      let ancestor = section.parentElement;
      while (ancestor && ancestor !== document.body) {
        add(ancestor, ancestor.id === "main" ? 95 : 50);
        ancestor = ancestor.parentElement;
      }
    }
    const root = document.scrollingElement;
    if (root && root.scrollHeight > root.clientHeight + 4) scored.push({ element: root, score: 20 });
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return root || document.documentElement;
    if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].element !== scored[1].element) {
      const firstContainsAll = sections.every((section) => scored[0].element.contains(section));
      const secondContainsAll = sections.every((section) => scored[1].element.contains(section));
      if (firstContainsAll === secondContainsAll) throw new api.ExportError(api.ERROR_CODES.AMBIGUOUS_SCROLL_ROOT, "Could not identify one conversation scroll container.");
    }
    return scored[0].element;
  }

  function isAtTop(root) {
    return Math.abs(Number(root.scrollTop) || 0) <= 2;
  }

  function isAtBottom(root) {
    return Number(root.scrollTop) + Number(root.clientHeight) >= Number(root.scrollHeight) - 2;
  }

  function hasRootSentinel() {
    return Boolean(document.querySelector('[data-turn-id-container="client-created-root"]'));
  }

  function hasVisibleRootSentinel(root) {
    const sentinel = document.querySelector('[data-turn-id-container="client-created-root"]');
    if (!sentinel || !root.contains(sentinel) || !isAtTop(root)) return false;
    const rootRect = root === document.scrollingElement
      ? { top: 0, bottom: innerHeight }
      : root.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    return sentinelRect.bottom >= rootRect.top - 4 && sentinelRect.top <= rootRect.bottom + 4;
  }

  function isGenerating() {
    return Boolean(document.querySelector("button[data-testid*='stop'], button[aria-label*='Stop generating' i], [data-testid='stop-button']"));
  }

  function expandCondensedMessages(attempted) {
    const attemptedButtons = attempted || new WeakSet();
    let clicked = 0;
    const sections = turnSections();
    for (const button of sections.flatMap((section) => Array.from(section.querySelectorAll("button[aria-expanded='false'], button")))) {
      if (attemptedButtons.has(button) || button.disabled || button.hidden || button.getAttribute("aria-hidden") === "true") continue;
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
      if (!/(?:show more|expand|view more)/i.test(label)) continue;
      attemptedButtons.add(button);
      button.click();
      clicked += 1;
    }
    return clicked;
  }

  function waitForDomSettle(root, timeoutMs) {
    return new Promise((resolve) => {
      let quietTimer;
      let finished = false;
      let mutations = 0;
      const minimumUntil = Date.now() + Math.max(0, timeoutMs - 100);
      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        resolve(mutations);
      };
      const scheduleQuietFinish = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, Math.max(220, minimumUntil - Date.now()));
      };
      const observer = new MutationObserver((records) => {
        mutations += records.length;
        scheduleQuietFinish();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-expanded", "data-testid", "data-turn-id"] });
      const hardTimer = setTimeout(finish, timeoutMs);
      scheduleQuietFinish();
    });
  }

  function scrollRootTo(root, top) {
    if (root.scrollTo) root.scrollTo({ top, behavior: "instant" });
    else root.scrollTop = top;
    try {
      root.dispatchEvent(new Event("scroll", { bubbles: true }));
    } catch (_) {
      // Assigning scrollTop is still sufficient on ordinary scrolling elements.
    }
  }

  async function requestEarlierHistory(root) {
    const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
    const sentinel = document.querySelector('[data-turn-id-container="client-created-root"]');
    // Leave the virtualizer's overscan area before re-entering the history edge.
    // A 160px nudge can leave the sentinel intersecting and never request another batch.
    let away = Math.min(Math.max(root.clientHeight * 2, 1600), maximum);
    for (let probe = 0; probe < 4; probe += 1) {
      scrollRootTo(root, away);
      await waitForDomSettle(root, api.LIMITS.settleMs);
      if (sentinel?.getAttribute('data-is-intersecting') !== 'true' || away >= maximum) break;
      away = Math.min(maximum, away * 2);
    }
    scrollRootTo(root, 0);
    await waitForDomSettle(root, api.LIMITS.historySettleMs);
  }

  function visibleTitle() {
    const active = document.querySelector("nav a[aria-current='page'], a[data-testid*='conversation'][aria-current='page']");
    const activeText = active && (active.getAttribute("aria-label") || active.textContent || "").trim();
    if (activeText && activeText.length <= 200) return activeText;
    const title = document.title.replace(/\s*[|–—-]\s*ChatGPT\s*$/i, "").replace(/^ChatGPT\s*[|–—-]\s*/i, "").trim();
    return title && !/^chatgpt$/i.test(title) ? title : "ChatGPT conversation";
  }

  function routeKind() {
    const path = location.pathname;
    if (/^\/share\//.test(path)) return "share";
    if (/^\/g\//.test(path)) return "custom-gpt";
    if (/\/project|\/projects\//.test(path)) return "project";
    if (/\/c\//.test(path)) return "conversation";
    return "rendered-conversation";
  }

  function notifyProgress(jobId, phase, cycle, turns, percent) {
    try {
      document.dispatchEvent(new CustomEvent("sp-chat-exporter-progress", {
        detail: { jobId, phase, cycle, turns, percent }
      }));
    } catch (_) {
      // The floating panel is optional; collection remains authoritative.
    }
    try {
      chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", jobId, phase, cycle, turns, percent });
    } catch (_) {
      // Popup progress is advisory; collection remains authoritative.
    }
  }

  function collectVisible(cache) {
    let changed = false;
    const visibleTurns = turnSections().map((section) => api.normalizeTurnSection(section)).filter(Boolean);
    changed = api.reconcileTurnPositions(cache, visibleTurns) || changed;
    for (const turn of visibleTurns) {
      changed = api.mergeTurn(cache, turn) || changed;
      if (api.orderedTurns(cache).length > api.LIMITS.maxTurns) throw new api.ExportError(api.ERROR_CODES.TURN_LIMIT_EXCEEDED, "The conversation exceeds 5,000 turns.");
    }
    return { changed, visibleTurns };
  }

  function virtualTurnSlots(root) {
    return Array.from(root.querySelectorAll('[data-turn-id-container][data-is-intersecting]'))
      .filter((node) => node.getAttribute('data-turn-id-container') !== 'client-created-root');
  }

  function observedEmptyTurn(slot, cache) {
    if (!slot.isConnected || slot.childNodes.length || slot.getAttribute('data-is-intersecting') !== 'true') return null;
    const previousId = slot.previousElementSibling?.getAttribute('data-turn-id-container');
    const nextId = slot.nextElementSibling?.getAttribute('data-turn-id-container');
    const turns = api.orderedTurns(cache);
    const previous = turns.find((turn) => turn.turnId === previousId);
    const next = turns.find((turn) => turn.turnId === nextId);
    if (!previous || !next || next.turnNumber !== previous.turnNumber + 2) return null;
    return {turnNumber:previous.turnNumber + 1, turnId:slot.getAttribute('data-turn-id-container'), role:'unknown', timestamp:null,
      markdown:'*ChatGPT renders no message content for this turn.*', attachments:[]};
  }

  async function collectConversation(rawOptions) {
    const options = api.validateOptions(rawOptions || {});
    cancellationRequested = false;
    const initialSections = turnSections();
    if (!initialSections.length) throw new api.ExportError(api.ERROR_CODES.NO_CONVERSATION, "No rendered ChatGPT conversation was found on this page.");
    if (isGenerating()) throw new api.ExportError(api.ERROR_CODES.ACTIVE_GENERATION, "Wait for ChatGPT to finish responding before exporting.");
    const root = findScrollRoot(initialSections);
    const cache = new Map();
    const warnings = [];
    const startedAt = Date.now();
    let stableBeginningChecks = 0;
    let stableEndingChecks = 0;
    let scanEndingChecks = 0;
    let cycle = 0;
    let lastSignature = "";
    let tailId = null;
    let latestAtBottom = null;
    let stopReason = "The beginning of the conversation could not be proven.";
    const attemptedExpansions = new WeakSet();
    let scanProgress = 0;

    const withinBudget = () => cycle < api.LIMITS.maxLoadCycles && Date.now() - startedAt < api.LIMITS.maxLoadMs;

    while (withinBudget()) {
      if (cancellationRequested) throw new api.ExportError(api.ERROR_CODES.CANCELLED, "Export cancelled.");
      cycle += 1;
      const expanded = expandCondensedMessages(attemptedExpansions);
      const { visibleTurns } = collectVisible(cache);
      const lastVisible = visibleTurns.reduce((latest, turn) => !latest || turn.turnNumber > latest.turnNumber ? turn : latest, null);
      const endingProof = isAtBottom(root) && Boolean(lastVisible);
      const sameTail = Boolean(tailId && lastVisible && api.sameTurnIdentity(cache, tailId, lastVisible.turnId));
      if (endingProof && sameTail && expanded === 0) stableEndingChecks += 1;
      else if (endingProof) {
        stableEndingChecks = 1;
        tailId = lastVisible.turnId;
        latestAtBottom = lastVisible.turnNumber;
      } else stableEndingChecks = 0;
      notifyProgress(options.jobId, "Finding the latest turn", cycle, api.orderedTurns(cache).length, null);
      if (stableEndingChecks >= api.LIMITS.stableBeginningChecks) break;
      scrollRootTo(root, Math.max(0, root.scrollHeight - root.clientHeight));
      await waitForDomSettle(root, api.LIMITS.settleMs);
    }

    if (stableEndingChecks < api.LIMITS.stableBeginningChecks || !tailId) {
      stopReason = "The latest turn could not be proven before history loading began.";
    }

    while (tailId && withinBudget()) {
      if (cancellationRequested) throw new api.ExportError(api.ERROR_CODES.CANCELLED, "Export cancelled.");
      cycle += 1;
      const expanded = expandCondensedMessages(attemptedExpansions);
      if (expanded) await waitForDomSettle(root, api.LIMITS.settleMs);
      const { visibleTurns } = collectVisible(cache);
      const turns = api.orderedTurns(cache);
      const visibleTurnOne = visibleTurns.some((turn) => turn.turnNumber === 1);
      const topProof = visibleTurnOne && hasVisibleRootSentinel(root);
      // Virtualized height estimates change as overscan mounts and unmounts.
      // History stability depends on message identities, not estimated pixels.
      const slots = virtualTurnSlots(root);
      const identities = slots.length
        ? slots.map((slot) => slot.getAttribute('data-turn-id-container')).join('|')
        : visibleTurns.map((turn) => `${turn.turnNumber}:${turn.turnId}`).join('|');
      const first = visibleTurns.find((turn) => turn.turnNumber === 1);
      const signature = `${first?.turnId || ''}|${first?.markdown || ''}|${identities}|${turns.length}`;
      // Remounted turns can recreate a Show more button on every edge visit.
      // Wait for its content above, then compare content instead of click count.
      if (topProof && signature === lastSignature) stableBeginningChecks += 1;
      else if (topProof) stableBeginningChecks = 1;
      else stableBeginningChecks = 0;
      lastSignature = signature;
      notifyProgress(options.jobId, "Loading earlier turns", cycle, turns.length, null);
      if (stableBeginningChecks >= api.LIMITS.stableBeginningChecks) break;
      await requestEarlierHistory(root);
    }

    if (tailId && stableBeginningChecks < api.LIMITS.stableBeginningChecks) {
      stopReason = "The first turn and visible conversation-root sentinel did not stabilize at the top.";
    }

    if (stableBeginningChecks >= api.LIMITS.stableBeginningChecks) {
      scrollRootTo(root, 0);
      await waitForDomSettle(root, api.LIMITS.settleMs);
      while (withinBudget()) {
        if (cancellationRequested) throw new api.ExportError(api.ERROR_CODES.CANCELLED, "Export cancelled.");
        cycle += 1;
        const expanded = expandCondensedMessages(attemptedExpansions);
        const { visibleTurns } = collectVisible(cache);
        const turns = api.orderedTurns(cache);
        const tailVisible = visibleTurns.some((turn) => api.sameTurnIdentity(cache, turn.turnId, tailId));
        const bottomProof = isAtBottom(root) && tailVisible;
        if (bottomProof && expanded === 0) scanEndingChecks += 1;
        else scanEndingChecks = 0;
        const denominator = Math.max(1, root.scrollHeight - root.clientHeight);
        scanProgress = Math.max(scanProgress, Math.min(96, Math.round((Math.min(root.scrollTop, denominator) / denominator) * 96)));
        notifyProgress(options.jobId, "Scanning every loaded turn", cycle, turns.length, scanProgress);
        if (scanEndingChecks >= api.LIMITS.stableBeginningChecks) break;
        const step = Math.max(240, Math.floor(root.clientHeight * 0.6));
        scrollRootTo(root, Math.min(root.scrollHeight - root.clientHeight, root.scrollTop + step));
        await waitForDomSettle(root, api.LIMITS.settleMs);
      }
      if (scanEndingChecks < api.LIMITS.stableBeginningChecks) stopReason = "The full top-to-bottom rendered-turn scan did not stabilize at the latest turn.";
    }

    // Virtual slots survive unmounting and expose empty turns that have no section.
    // Revisit them when a scan encountered late prepends or unmounted messages.
    for (let repair = 0; repair < 3 && withinBudget() && (api.coverageState(cache, tailId).gaps.length || stableBeginningChecks < api.LIMITS.stableBeginningChecks); repair += 1) {
      const slots = virtualTurnSlots(root);
      if (!slots.length) break;
      const firstId = slots[0].getAttribute('data-turn-id-container');
      let firstProven = false;
      for (let index = 0; index < slots.length && withinBudget(); index += 1) {
        if (cancellationRequested) throw new api.ExportError(api.ERROR_CODES.CANCELLED, "Export cancelled.");
        const slot = slots[index];
        if (!slot.isConnected) break;
        cycle += 1;
        if (index === 0) scrollRootTo(root, 0);
        else slot.scrollIntoView({block:'center',behavior:'instant'});
        await waitForDomSettle(root, api.LIMITS.settleMs);
        collectVisible(cache);
        if (index === 0) {
          let checks = 0;
          while (checks < api.LIMITS.stableBeginningChecks && withinBudget()) {
            if (!hasVisibleRootSentinel(root) || !api.orderedTurns(cache).some((turn) => turn.turnId === firstId && turn.turnNumber === 1)) break;
            checks += 1;
            if (checks < api.LIMITS.stableBeginningChecks) {
              cycle += 1;
              await waitForDomSettle(root, api.LIMITS.historySettleMs);
              collectVisible(cache);
            }
          }
          firstProven = checks === api.LIMITS.stableBeginningChecks;
        }
        if (!slot.childNodes.length && slot.getAttribute('data-is-intersecting') === 'true') {
          let emptyChecks = 1;
          while (emptyChecks < api.LIMITS.stableBeginningChecks && withinBudget()) {
            cycle += 1;
            await waitForDomSettle(root, api.LIMITS.settleMs);
            collectVisible(cache);
            if (slot.childNodes.length || slot.getAttribute('data-is-intersecting') !== 'true') break;
            emptyChecks += 1;
          }
          if (emptyChecks === api.LIMITS.stableBeginningChecks) {
            const empty = observedEmptyTurn(slot, cache);
            if (empty) api.mergeTurn(cache, empty);
          }
        }
        notifyProgress(options.jobId, "Checking rendered turn slots", cycle, api.orderedTurns(cache).length, scanProgress);
      }
      if (firstProven && virtualTurnSlots(root)[0]?.getAttribute('data-turn-id-container') === firstId
          && api.orderedTurns(cache).some((turn) => turn.turnId === firstId && turn.turnNumber === 1)) {
        stableBeginningChecks = api.LIMITS.stableBeginningChecks;
      } else stableBeginningChecks = 0;
      scanEndingChecks = 0;
      while (scanEndingChecks < api.LIMITS.stableBeginningChecks && withinBudget()) {
        cycle += 1;
        scrollRootTo(root, Math.max(0, root.scrollHeight - root.clientHeight));
        await waitForDomSettle(root, api.LIMITS.settleMs);
        const {visibleTurns} = collectVisible(cache);
        if (isAtBottom(root) && visibleTurns.some((turn) => api.sameTurnIdentity(cache, turn.turnId, tailId))) scanEndingChecks += 1;
        else break;
      }
    }

    if (cycle >= api.LIMITS.maxLoadCycles) stopReason = "The 300-cycle history-loading limit was reached.";
    if (Date.now() - startedAt >= api.LIMITS.maxLoadMs) stopReason = "The eight-minute history-loading limit was reached.";
    collectVisible(cache);
    const turns = api.orderedTurns(cache);
    const coverage = api.coverageState(cache, tailId);
    if (scanEndingChecks >= api.LIMITS.stableBeginningChecks && (coverage.gaps.length || coverage.duplicatePositions || !coverage.tailIsLatest)) {
      stopReason = "The rendered scan reached the latest turn with unresolved turn gaps or duplicate positions.";
    }
    const complete = stableBeginningChecks >= api.LIMITS.stableBeginningChecks
      && scanEndingChecks >= api.LIMITS.stableBeginningChecks
      && coverage.latestCovered
      && coverage.tailIsLatest
      && !coverage.duplicatePositions
      && coverage.gaps.length === 0;
    if (!complete) warnings.push(stopReason);
    const attachments = turns.flatMap((turn) => turn.attachments);
    const snapshot = {
      schemaVersion: 1,
      title: visibleTitle(),
      sourceUrl: location.href,
      routeKind: routeKind(),
      exportedAt: new Date().toISOString(),
      complete,
      completion: {
        turnOneObserved: turns.some((turn) => turn.turnNumber === 1),
        turnOneStableChecks: stableBeginningChecks,
        topObserved: stableBeginningChecks >= api.LIMITS.stableBeginningChecks,
        sentinelObserved: hasRootSentinel(),
        bottomObserved: scanEndingChecks >= api.LIMITS.stableBeginningChecks,
        fullScanCompleted: scanEndingChecks >= api.LIMITS.stableBeginningChecks,
        latestAtStart: latestAtBottom,
        latestCovered: coverage.latestCovered,
        latestTurnNumber: coverage.latestNumber,
        gaps: coverage.gaps,
        cycles: cycle,
        elapsedMs: Date.now() - startedAt,
        reason: complete ? null : stopReason
      },
      turns,
      attachments,
      warnings
    };
    api.validateSnapshot(snapshot);
    const markdown = api.renderConversationMarkdown(snapshot, options);
    notifyProgress(options.jobId, complete ? "Conversation verified" : "Partial transcript ready", cycle, turns.length, 100);
    return { options, snapshot, markdown };
  }

  function cancelCollection() {
    cancellationRequested = true;
  }

  api.cancelCollection = cancelCollection;
  api.collectConversation = collectConversation;
  api.expandCondensedMessages = expandCondensedMessages;
  api.findScrollRoot = findScrollRoot;
  api.turnSections = turnSections;
})(globalThis);
