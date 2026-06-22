// Single source of truth for all plan tiers and what each includes.
// Change a plan's features or limits HERE and every business on that plan
// updates automatically — no per-client changes ever needed.

const PLANS = {
  starter: {
    label: 'Starter',
    monthlyCallLimit: 50,
    bookingMode: 'rule_based',     // rule-based booking, not full AI
    reminders: false,              // no 24-hour reminders
    emailNotifications: false,     // SMS notifications only
    followUpFlagging: false,
    analytics: false,
    dashboard: 'basic',
  },
  basic: {
    label: 'Basic',
    monthlyCallLimit: 150,
    bookingMode: 'full_ai',
    reminders: true,
    emailNotifications: true,
    followUpFlagging: true,
    analytics: false,
    dashboard: 'full',
  },
  pro: {
    label: 'Pro',
    monthlyCallLimit: Infinity,    // unlimited
    bookingMode: 'full_ai',
    reminders: true,
    emailNotifications: true,
    followUpFlagging: true,
    analytics: true,
    dashboard: 'full_analytics',
  },
};

// Always returns a valid plan config. Falls back to 'basic' if a business
// has a missing or unrecognized plan value, so nothing ever breaks.
function getPlan(planName) {
  return PLANS[planName] || PLANS.basic;
}

// Convenience: does this business's plan include a given feature?
function planAllows(planName, feature) {
  const plan = getPlan(planName);
  return !!plan[feature];
}

module.exports = { PLANS, getPlan, planAllows };