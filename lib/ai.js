const Anthropic = require('@anthropic-ai/sdk');
const { ALLOWED_CATEGORIES, basePriceForCategory, clampSuggestedPrice } = require('./pricing');

let anthropic = null;

function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

const SYSTEM_PROMPT = `You are cataloging a single donated secondhand item from a photo for a thrift store.

Return ONLY a JSON object, no prose, no markdown code fences, no explanation. The object must match exactly this shape:

{
  "title": "string, max 60 chars",
  "category": "one of: books|kitchenware|home_decor|tools|electronics|toys|furniture|clothing|other",
  "description": "2-3 sentences, factual, no invented brand claims",
  "condition_notes": "visible wear, stains, damage, or 'none visible'",
  "suggested_price_cents": 1200,
  "confidence": "high|medium|low"
}

Only describe what is visibly present in the photo. Do not guess at brands, materials, or history you cannot see.`;

function stripFences(text) {
  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function emptyDraftFields() {
  return { title: null, category: null, description: null, conditionNotes: null, priceCents: null, confidence: null };
}

// Never trust the model's output shape — validate every field, falling back to safe
// defaults (Section 8). This is what lets intake proceed even on a bad AI response.
function validateFields(parsed) {
  const category = ALLOWED_CATEGORIES.includes(parsed.category) ? parsed.category : 'other';

  const title =
    typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : null;

  const description =
    typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : null;

  const conditionNotes =
    typeof parsed.condition_notes === 'string' && parsed.condition_notes.trim()
      ? parsed.condition_notes.trim()
      : null;

  const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';

  const suggested = Number(parsed.suggested_price_cents);
  const validSuggestion = Number.isFinite(suggested) && suggested > 0 ? suggested : basePriceForCategory(category);
  const priceCents = clampSuggestedPrice(category, validSuggestion);

  return { title, category, description, conditionNotes, priceCents, confidence };
}

// AI output is always a draft (Section 2) and intake must never hard-fail because the
// model errored or returned garbage — on any failure we still return empty fields so a
// human can fill the item in manually.
async function analyzeItemPhoto(imageBuffer, mimeType) {
  let response;
  try {
    response = await getClient().messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBuffer.toString('base64') } },
            { type: 'text', text: 'Analyze this item photo and return the JSON object described in the system prompt.' }
          ]
        }
      ]
    });
  } catch (err) {
    console.error('analyzeItemPhoto: Claude API call failed:', err.message);
    return { fields: emptyDraftFields(), raw: null };
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  const parsed = textBlock ? safeParseJson(stripFences(textBlock.text)) : null;

  if (!parsed) {
    console.error('analyzeItemPhoto: could not parse JSON from model response');
    return { fields: emptyDraftFields(), raw: response };
  }

  return { fields: validateFields(parsed), raw: response };
}

module.exports = { analyzeItemPhoto };
