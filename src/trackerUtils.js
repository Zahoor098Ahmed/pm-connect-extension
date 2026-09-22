/** Has enough time passed since the last poll to poll again? */
function shouldFallbackPoll(lastPolledAt, now, intervalMs) {
  return !lastPolledAt || now - lastPolledAt >= intervalMs;
}

/** Is the developer idle right now, given their last activity signal? */
function computeIdleGate(lastActivityAt, now, idleThresholdMs) {
  if (!lastActivityAt) return true;
  return now - lastActivityAt >= idleThresholdMs;
}

/** How many seconds this tick should add to the pending buffer. */
function accumulateSeconds(windowFocused, isIdle, tickSeconds) {
  return windowFocused && !isIdle ? tickSeconds : 0;
}

module.exports = { shouldFallbackPoll, computeIdleGate, accumulateSeconds };
