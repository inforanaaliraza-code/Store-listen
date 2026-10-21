const PRODUCT_TERMS = [
  { product: 'phone charger', terms: ['charger', 'charging cable', 'charge cable', 'cargador'] },
  { product: 'phone', terms: ['iphone', 'android phone', 'smartphone', 'mobile phone'] },
  { product: 'phone case', terms: ['phone case', 'case for my phone', 'funda'] },
  { product: 'headphones', terms: ['headphones', 'earbuds', 'headset'] },
  { product: 'screen protector', terms: ['screen protector', 'tempered glass'] },
  { product: 'other product', terms: ['product', 'item', 'accessory', 'accessories'] },
];

const POSITIVE_TERMS = ['love it', 'great', 'perfect', 'thank you', 'thanks', 'happy', 'excellent'];
const NEGATIVE_TERMS = ['angry', 'disappointed', 'frustrated', 'unhappy', 'terrible', 'complaint', 'does not work'];
const CUSTOMER_INTENT_TERMS = ['looking for', 'need', 'want', 'do you have', 'how much', 'price', 'buy', 'purchase', 'interested in'];

function containsAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

export function analyzeConversation(transcript) {
  const combined = transcript.map((segment) => segment.text).join(' ').toLowerCase();
  const customerText = transcript
    .filter((segment) => segment.role === 'customer')
    .map((segment) => segment.text)
    .join(' ')
    .toLowerCase();
  const productMatch = PRODUCT_TERMS.find(({ terms }) => containsAny(combined, terms));
  const intentFound = containsAny(customerText || combined, CUSTOMER_INTENT_TERMS);
  const opportunities = productMatch && intentFound
    ? [{
      customer_intent: 'Customer asked about or expressed a need for a product',
      product_name: productMatch.product,
      status: 'REVIEW_REQUIRED',
      confidence: 0.65,
      recommendation: 'Confirm the customer’s exact product, compatibility, price, and availability before making a sales claim.',
    }]
    : [];
  const recommendations = opportunities.length
    ? [{
      title: 'Confirm product details',
      message: opportunities[0].recommendation,
      confidence: 0.65,
    }]
    : [];
  const sentiment = containsAny(combined, POSITIVE_TERMS) && containsAny(combined, NEGATIVE_TERMS)
    ? 'mixed'
    : containsAny(combined, NEGATIVE_TERMS)
      ? 'negative'
      : containsAny(combined, POSITIVE_TERMS)
        ? 'positive'
        : 'unknown';
  const summary = productMatch
    ? `Transcript contains a mention of ${productMatch.product}${intentFound ? ' and a possible customer request' : ''}. Rule-based signal; review the transcript.`
    : 'No product match was found by the configured phrase rules. Review the transcript for context.';
  return {
    opportunities,
    recommendations,
    intents: opportunities.map((opportunity) => ({
      intent: opportunity.customer_intent,
      product: opportunity.product_name,
      confidence: opportunity.confidence,
    })),
    report: {
      summary,
      customer_needs: opportunities.length ? [opportunities[0].product_name] : [],
      customer_sentiment: sentiment,
      products_discussed: productMatch ? [productMatch.product] : [],
      opportunity_type: opportunities.length ? 'potential' : 'none',
      opportunity_summary: opportunities.length
        ? 'A phrase rule found a possible product request; this is not proof of a missed or completed sale.'
        : 'No product-request signal was found by the configured phrase rules.',
      recommendation: opportunities[0]?.recommendation || 'Review the transcript and confirm any customer request directly.',
      evidence: productMatch ? `Matched product phrase in transcript: ${productMatch.product}.` : 'No supported product phrase match.',
      confidence: opportunities.length ? 0.65 : 0.35,
    },
  };
}

export function createCoachingSuggestion(text) {
  const normalized = String(text || '').toLowerCase();
  const asksAvailability = /\b(available|in stock|do you have|do you carry|stock)\b/.test(normalized);
  const asksPricing = /\b(how much|price|cost|discount)\b/.test(normalized);
  const recommendation = asksAvailability
    ? 'Check the live inventory record before confirming availability.'
    : asksPricing
      ? 'Verify the current price and any active offer before quoting.'
      : 'Acknowledge the request and ask one concise clarifying question.';
  const alerts = [];
  if (asksAvailability) alerts.push({ title: 'Verify availability', message: 'Check live inventory before promising the item is in stock.' });
  if (asksPricing) alerts.push({ title: 'Confirm current price', message: 'Check the current SKU price and active offer before quoting.' });
  return {
    recommendation,
    confidence: 0.55,
    objections: [],
    alerts,
    provider: 'rules',
  };
}

export function summarizeDailyReport(metrics, evidence) {
  const conversations = Number(metrics.conversations || 0);
  const revenue = Object.entries(metrics.revenue_by_currency || {})
    .map(([currency, amount]) => `${currency} ${Number(amount).toFixed(2)}`)
    .join(', ');
  const topProducts = new Map();
  for (const item of evidence) {
    const match = PRODUCT_TERMS.find(({ terms }) => containsAny(String(item.transcript || '').toLowerCase(), terms));
    if (match) topProducts.set(match.product, (topProducts.get(match.product) || 0) + 1);
  }
  const productPoints = [...topProducts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([product, count]) => `${product}: mentioned in ${count} conversation(s).`);
  const keyPoints = [
    `${conversations} live conversation(s) were recorded.`,
    metrics.sales_data_available
      ? `${metrics.sales_count} verified POS transaction(s); revenue ${revenue || 'not available'}.`
      : 'Live POS data unavailable; revenue is not estimated.',
    ...productPoints,
  ];
  const actions = [];
  if (metrics.potential_missed_opportunities) actions.push(`Review ${metrics.potential_missed_opportunities} potential opportunity signal(s) with a manager.`);
  if (metrics.low_stock) actions.push(`Check ${metrics.low_stock} below-par inventory item(s).`);
  if (!metrics.sales_data_available) actions.push('Connect a live POS feed before drawing conclusions about sales.');
  if (!actions.length) actions.push('Review transcript-backed signals and confirm any customer follow-up.');
  return {
    headline: `${conversations} conversation(s) · ${metrics.sales_data_available ? revenue || 'POS revenue unavailable' : 'POS revenue unavailable'}`,
    executive_summary: `Rule-based daily summary: ${conversations} live conversation(s), ${Number(metrics.transcript_segments || 0)} transcript segment(s), and ${metrics.sales_data_available ? `${Number(metrics.sales_count || 0)} verified POS transaction(s)` : 'no live POS sales data available'}. This is a factual aggregation, not a generative AI assessment.`,
    key_points: keyPoints,
    findings: keyPoints,
    actions_for_tomorrow: actions,
    sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0, sample_size: 0 },
    confidence: 0.5,
    provider: 'rules',
    status: 'completed',
  };
}
