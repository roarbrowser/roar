// The sidebar's space dots. A ring means agents (CDP clients) can reach that space now: CDP is open and the space
// allows agents (the same per-space flag mcp use_profile checks). Clicking the space you are on toggles that;
// clicking another space switches to it. The active space is the larger, fully opaque dot.
const spaceDot = (sp, s, i) => {
  const ring = !!(s.settings?.cdpOn && sp.agents), active = sp.id === s.activeSpace;
  // s.tabs holds only the current space's tabs, so "in use" is known for that dot alone.
  const used = active && ring ? (s.tabs || []).filter((t) => t.agentActive).length : 0;
  const agents = `agents ${ring ? 'allowed' : 'off'}${used ? `, ${used} tab${used > 1 ? 's' : ''} in use by an agent` : ''}`;
  return {
    ring, active, busy: used > 0,
    label: `${sp.name}${active ? ' (current space)' : ''}, ${agents}`,
    title: active ? `${sp.name}: ${agents} — click to turn ${ring ? 'off' : 'on'}` : `${sp.name}: ${agents} — click to switch (⌃${i + 1})`,
  };
};
// What a click on space `id` does: 'agents' toggles the current space's agent access, 'switch' moves to it.
const spaceDotAction = (id, s) => (id === s.activeSpace ? 'agents' : 'switch');
// The one-time coach mark that explains the ring: the first time the current space shows one.
// Only after onboarding, once agents had access here and then lost it (turned off or CDP closed);
// waits while any alert card shows so the two never stack.
const spaceRingCoach = (s) => !!s.settings?.onboarded && !!s.settings?.agentsHadRing && !s.settings?.agentRingSeen && !s.alerts?.length &&
  !spaceDot(s.spaces.find((sp) => sp.id === s.activeSpace) || {}, s, 0).ring;
if (typeof module === 'object') module.exports = { spaceDot, spaceDotAction, spaceRingCoach };
