(function initializeTurnNormalizer(global) {
  "use strict";

  const api = global.ChatGPTExporter = global.ChatGPTExporter || {};

  function parseTurnNumber(section) {
    const testId = section.getAttribute("data-testid") || "";
    const testMatch = testId.match(/^conversation-turn-(\d+)$/);
    if (testMatch) return Number(testMatch[1]);
    const raw = section.getAttribute("data-turn") || "";
    const rawMatch = raw.match(/(?:^|[^0-9])(\d+)(?:$|[^0-9])/);
    return rawMatch ? Number(rawMatch[1]) : null;
  }

  function roleFor(section, roots) {
    const roles = roots.map((root) => root.getAttribute("data-message-author-role")).filter(Boolean);
    if (roles.includes("user")) return "user";
    if (roles.includes("assistant")) return "assistant";
    if (roles.includes("tool")) return "tool";
    const label = `${section.getAttribute("aria-label") || ""} ${section.textContent || ""}`.slice(0, 200);
    if (/\byou said\b|\buser\b/i.test(label)) return "user";
    if (/\bchatgpt said\b|\bassistant\b/i.test(label)) return "assistant";
    return "unknown";
  }

  function topLevelMessageRoots(section) {
    const roots = Array.from(section.querySelectorAll("[data-message-author-role]"));
    return roots.filter((candidate) => !roots.some((other) => other !== candidate && other.contains(candidate)));
  }

  function filenameFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, global.location.href);
      return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "attachment");
    } catch (_) {
      return "attachment";
    }
  }

  function meaningfulImage(image) {
    if (!image.getAttribute("src")) return false;
    if (image.closest("button, [data-testid*='avatar'], [aria-label*='avatar' i]")) return false;
    const width = image.naturalWidth || Number(image.getAttribute("width")) || image.getBoundingClientRect?.().width || 0;
    const height = image.naturalHeight || Number(image.getAttribute("height")) || image.getBoundingClientRect?.().height || 0;
    return Boolean(image.getAttribute("alt")) || width >= 64 || height >= 64;
  }

  function collectAttachments(section, turnNumber, turnId, ownerRole) {
    const candidates = [];
    const seenNodes = new Set();
    const groups = Array.from(section.querySelectorAll("[role='group'], [data-testid='library-file-icon']"));
    for (const node of groups) {
      const group = node.getAttribute("role") === "group" ? node : node.closest("[role='group']") || node.parentElement;
      if (!group || seenNodes.has(group)) continue;
      const label = group.getAttribute("aria-label") || group.querySelector("[aria-label]")?.getAttribute("aria-label") || group.textContent || "";
      const nameMatch = label.trim().match(/([^\n]+?\.[a-z0-9]{1,12})(?:\s|$)/i);
      if (!nameMatch && !group.querySelector("[data-testid='library-file-icon']")) continue;
      seenNodes.add(group);
      const anchor = group.closest("a[href]") || group.querySelector("a[href]");
      candidates.push({
        node: group,
        name: nameMatch ? nameMatch[1].trim() : label.trim() || "attachment",
        url: anchor && anchor.href,
        mimeType: group.getAttribute("data-mime-type") || ""
      });
    }
    for (const anchor of Array.from(section.querySelectorAll("a[href][download], a[href*='download'], a[href*='sandbox']"))) {
      if (Array.from(seenNodes).some((node) => node.contains(anchor))) continue;
      candidates.push({
        node: anchor,
        name: anchor.getAttribute("download") || anchor.getAttribute("aria-label") || anchor.textContent.trim() || filenameFromUrl(anchor.href),
        url: anchor.href,
        mimeType: anchor.getAttribute("type") || ""
      });
    }
    for (const image of Array.from(section.querySelectorAll("img[src]")).filter(meaningfulImage)) {
      candidates.push({
        node: image,
        name: image.getAttribute("alt") || filenameFromUrl(image.src) || `image-turn-${turnNumber}`,
        url: image.src,
        mimeType: "image/*",
        semanticKind: "image"
      });
    }
    const seen = new Set();
    return candidates.reduce((items, candidate, index) => {
      const originalFilename = api.sanitizeFilenamePart(candidate.name, candidate.semanticKind === "image" ? `image-turn-${turnNumber}` : "attachment");
      const classification = api.classifyAttachmentUrl(candidate.url);
      const key = `${originalFilename.toLocaleLowerCase("en-US")}|${classification.url || "protected"}`;
      if (seen.has(key)) return items;
      seen.add(key);
      items.push({
        id: `${turnId}:${items.length + 1}`.replace(/[^a-z0-9:._-]/gi, "-"),
        turnNumber,
        turnId,
        ownerRole: ownerRole === "user" ? "user" : "assistant",
        semanticKind: candidate.semanticKind || (api.isTextAttachment({ originalFilename, mimeType: candidate.mimeType }) ? "text" : "file"),
        originalFilename,
        mimeType: candidate.mimeType || "",
        size: null,
        sourceCategory: classification.kind,
        url: classification.url,
        originPattern: classification.originPattern || null,
        requiresSelection: classification.kind === "protected" || classification.kind === "invalid" || classification.kind === "unsupported-origin",
        reason: classification.reason || null,
        status: "discovered"
      });
      return items;
    }, []);
  }

  function extractTimestamp(section) {
    const time = section.querySelector("time[datetime]");
    const value = time?.getAttribute("datetime");
    const label = (time?.textContent || value || "").trim();
    if (value && label && !Number.isNaN(Date.parse(value))) return { label, value, source: "time[datetime]" };
    const separator = section.previousElementSibling;
    if (separator?.getAttribute('role') !== 'separator'
        || section.parentElement?.getAttribute('data-turn-id-container') !== section.getAttribute('data-turn-id')) return null;
    const displayed = (separator.getAttribute('aria-label') || separator.textContent || '').trim();
    if (!displayed || displayed.length > 100) return null;
    const relative = displayed.match(/^(Today|Yesterday)\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (relative && Number(relative[2]) >= 1 && Number(relative[2]) <= 12 && Number(relative[3]) < 60) {
      const date = new Date();
      if (/yesterday/i.test(relative[1])) date.setDate(date.getDate() - 1);
      date.setHours(Number(relative[2]) % 12 + (/pm/i.test(relative[4]) ? 12 : 0), Number(relative[3]), 0, 0);
      return { label: displayed, value: date.toISOString(), source: 'adjacent-date-separator' };
    }
    // A weekday alone does not establish a calendar date. Preserve its exact label.
    if (/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(displayed)) {
      return { label: displayed, value: null, source: 'adjacent-date-separator' };
    }
    return null;
  }

  function normalizeTurnSection(section) {
    const turnNumber = parseTurnNumber(section);
    if (!Number.isInteger(turnNumber)) return null;
    const roots = topLevelMessageRoots(section);
    const role = roleFor(section, roots);
    const turnId = section.getAttribute("data-turn-id") || section.getAttribute("data-message-id") || roots.map((root) => root.getAttribute("data-message-id")).find(Boolean) || `turn-${turnNumber}`;
    const markdownParts = roots.map((root) => api.normalizeMarkdownDocument(api.markdownChildrenToText(root, {}))).filter(Boolean);
    const attachments = collectAttachments(section, turnNumber, turnId, role);
    return {
      turnNumber,
      turnId,
      role,
      timestamp: extractTimestamp(section),
      markdown: api.normalizeMarkdownDocument(markdownParts.join("\n\n")),
      attachments
    };
  }

  function turnScore(turn) {
    return turn.markdown.length + turn.attachments.length * 80;
  }

  function aliasesFor(cache) {
    if (!cache.__turnAliases) Object.defineProperty(cache, "__turnAliases", { value: new Map(), configurable: true });
    return cache.__turnAliases;
  }

  function canonicalTurnId(cache, turnId) {
    const aliases = aliasesFor(cache);
    let current = turnId;
    const visited = new Set();
    while (aliases.has(current) && !visited.has(current)) {
      visited.add(current);
      current = aliases.get(current);
    }
    return current;
  }

  function cachedTurn(cache, turnId) {
    return cache.get(canonicalTurnId(cache, turnId));
  }

  function hasTurnIdentity(cache, turnId) {
    return Boolean(cachedTurn(cache, turnId));
  }

  function sameTurnIdentity(cache, leftId, rightId) {
    if (!leftId || !rightId) return false;
    return canonicalTurnId(cache, leftId) === canonicalTurnId(cache, rightId);
  }

  function coverageState(cache, tailId) {
    const turns = orderedTurns(cache);
    const tail = cachedTurn(cache, tailId);
    const latestNumber = tail ? tail.turnNumber : 0;
    const maximumObserved = turns.length ? turns[turns.length - 1].turnNumber : 0;
    const uniqueNumbers = new Set(turns.map((turn) => turn.turnNumber));
    return {
      latestNumber,
      maximumObserved,
      latestCovered: Boolean(tail),
      tailIsLatest: Boolean(tail && latestNumber === maximumObserved),
      duplicatePositions: uniqueNumbers.size !== turns.length,
      gaps: tail ? unresolvedGaps(turns, latestNumber) : []
    };
  }

  function replaceTurnIdentity(cache, previousId, turn) {
    const aliases = aliasesFor(cache);
    cache.delete(previousId);
    for (const [alias, canonical] of aliases.entries()) {
      if (canonical === previousId) aliases.set(alias, turn.turnId);
    }
    aliases.set(previousId, turn.turnId);
    cache.set(turn.turnId, turn);
  }

  function sameAttachmentShape(left, right) {
    const describe = (items) => items.map((item) => `${item.ownerRole}|${item.semanticKind}|${item.originalFilename}|${item.url || ""}`).join("\n");
    return describe(left.attachments) === describe(right.attachments);
  }

  function contentIsCompatible(existing, incoming) {
    if (existing.role !== incoming.role) return false;
    if (!sameAttachmentShape(existing, incoming)) return false;
    if (existing.markdown === incoming.markdown) return true;
    const shorter = existing.markdown.length <= incoming.markdown.length ? existing.markdown : incoming.markdown;
    const longer = shorter === existing.markdown ? incoming.markdown : existing.markdown;
    return Boolean(shorter) && longer.includes(shorter);
  }

  function updateTurnPosition(turn, turnNumber) {
    turn.turnNumber = turnNumber;
    turn.attachments = turn.attachments.map((attachment) => Object.assign({}, attachment, { turnNumber }));
    return turn;
  }

  function reconcileTurnPositions(cache, visibleTurns) {
    const deltas = new Set();
    for (const turn of visibleTurns) {
      const existing = cachedTurn(cache, turn.turnId);
      if (existing) deltas.add(turn.turnNumber - existing.turnNumber);
    }
    deltas.delete(0);
    if (deltas.size > 1) {
      throw new api.ExportError(api.ERROR_CODES.CONFLICTING_TURN, "Rendered turn positions shifted inconsistently while loading.");
    }
    if (deltas.size === 1) {
      const delta = Array.from(deltas)[0];
      for (const turn of cache.values()) {
        const nextNumber = turn.turnNumber + delta;
        if (!Number.isInteger(nextNumber) || nextNumber < 1 || nextNumber > api.LIMITS.maxTurns) {
          throw new api.ExportError(api.ERROR_CODES.CONFLICTING_TURN, "Rendered turn positions moved outside the supported range.");
        }
        updateTurnPosition(turn, nextNumber);
      }
    }
    return deltas.size === 1;
  }

  function mergeTurn(cache, turn) {
    let existing = cachedTurn(cache, turn.turnId);
    if (!existing) {
      const samePosition = Array.from(cache.entries()).filter(([, candidate]) => candidate.turnNumber === turn.turnNumber);
      const incompatibleRole = samePosition.find(([, candidate]) => candidate.markdown === turn.markdown && candidate.role !== turn.role);
      if (incompatibleRole) {
        throw new api.ExportError(api.ERROR_CODES.CONFLICTING_TURN, `Turn ${turn.turnNumber} changed role while loading.`);
      }
      const compatible = samePosition.filter(([, candidate]) => contentIsCompatible(candidate, turn));
      if (compatible.length > 1) {
        throw new api.ExportError(api.ERROR_CODES.CONFLICTING_TURN, `Turn ${turn.turnNumber} matched multiple rendered identities.`);
      }
      if (compatible.length === 1) {
        const [previousId, candidate] = compatible[0];
        existing = candidate;
        aliasesFor(cache).set(previousId, turn.turnId);
      } else {
        cache.set(turn.turnId, turn);
        return true;
      }
    }
    if (existing.role !== turn.role) {
      throw new api.ExportError(api.ERROR_CODES.CONFLICTING_TURN, `Turn ${turn.turnNumber} changed role while loading.`);
    }
    const existingScore = turnScore(existing);
    const incomingScore = turnScore(turn);
    if (incomingScore > existingScore) {
      replaceTurnIdentity(cache, existing.turnId, turn);
      return true;
    }
    if (incomingScore === existingScore && existing.markdown !== turn.markdown) {
      throw new api.ExportError(api.ERROR_CODES.CONFLICTING_TURN, `Turn ${turn.turnNumber} produced conflicting stable content.`);
    }
    if (existing.turnId !== turn.turnId) {
      replaceTurnIdentity(cache, existing.turnId, Object.assign({}, existing, {
        turnNumber: turn.turnNumber,
        turnId: turn.turnId,
        attachments: existing.attachments.map((attachment, index) => Object.assign({}, attachment, {
          id: `${turn.turnId}:${index + 1}`.replace(/[^a-z0-9:._-]/gi, "-"),
          turnNumber: turn.turnNumber,
          turnId: turn.turnId
        }))
      }));
      return true;
    }
    updateTurnPosition(existing, turn.turnNumber);
    return false;
  }

  function orderedTurns(cache) {
    return Array.from(cache.values()).sort((a, b) => a.turnNumber - b.turnNumber);
  }

  function unresolvedGaps(turns, latestNumber) {
    if (!turns.length) return [];
    const numbers = new Set(turns.map((turn) => turn.turnNumber));
    const gaps = [];
    for (let value = 1; value <= latestNumber; value += 1) if (!numbers.has(value)) gaps.push(value);
    return gaps;
  }

  api.collectAttachments = collectAttachments;
  api.coverageState = coverageState;
  api.hasTurnIdentity = hasTurnIdentity;
  api.mergeTurn = mergeTurn;
  api.normalizeTurnSection = normalizeTurnSection;
  api.orderedTurns = orderedTurns;
  api.parseTurnNumber = parseTurnNumber;
  api.reconcileTurnPositions = reconcileTurnPositions;
  api.sameTurnIdentity = sameTurnIdentity;
  api.unresolvedGaps = unresolvedGaps;
})(globalThis);
