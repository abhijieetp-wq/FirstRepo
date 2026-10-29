/**
 * ERP 2.0's AI commands: a request typed or spoken in plain words, read by Claude into the
 * actions it asks for. Claude only proposes; nothing is written here. AiCommands.gs turns the
 * proposal into actions the person ticks, and those go through the portal's own saves with
 * their own permission checks.
 *
 * The key is the server's ANTHROPIC_API_KEY environment variable — on Railway, a variable on
 * the service. It is never stored in the database, never sent to a browser, never logged.
 * Without it the commands are off and say so.
 *
 * What goes to Anthropic: the words typed, the person's name and role, today's date, and the
 * ERP's own short lists (call types, visit purposes, area names). No customer list, no prices,
 * no records — names in the request are matched to customers and staff here, afterwards.
 */
'use strict';

let Anthropic = null;
try {
  const mod = require('@anthropic-ai/sdk');
  Anthropic = mod.default || mod;
} catch (err) {
  Anthropic = null;
}

// The current Opus. ERP_AI_MODEL changes it without a release, should PIE want another.
const MODEL = process.env.ERP_AI_MODEL || 'claude-opus-5-5';

function off(reason) {
  return { enabled: false, reason, propose: async () => { throw new Error(reason); } };
}

/**
 * @param opts.client  an Anthropic client, for tests; made from the environment otherwise
 * @param opts.env     the environment to read, for tests
 */
function aiService(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  let client = o.client || null;
  if (!client) {
    if (!String(env.ANTHROPIC_API_KEY || '').trim()) {
      return off('AI commands are off: the server has no ANTHROPIC_API_KEY. Management sets it on the hosting service.');
    }
    if (!Anthropic) return off('AI commands are off: the server is missing the @anthropic-ai/sdk package.');
    // An interactive request: a minute and a half, one retry, then say so.
    client = new Anthropic({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), timeout: 90 * 1000, maxRetries: 1 });
  }
  const Errors = Anthropic || {};

  return {
    enabled: true,
    model: MODEL,
    /**
     * @param req.system  the standing instructions
     * @param req.text    the request, with today's date and who is asking
     * @param req.schema  the JSON schema the answer must follow
     * @return the parsed answer
     */
    async propose(req) {
      let response;
      try {
        response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          // A declined request is re-run on Anthropic's recommended fallback model rather
          // than returned as a refusal.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          // Reading a short request into a few fields: low effort is enough, and quick.
          output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
          system: req.system,
          messages: [{ role: 'user', content: req.text }]
        });
      } catch (err) {
        if (Errors.AuthenticationError && err instanceof Errors.AuthenticationError) {
          throw new Error('The AI key was not accepted. Management checks ANTHROPIC_API_KEY on the hosting service.');
        }
        if (Errors.RateLimitError && err instanceof Errors.RateLimitError) {
          throw new Error('The AI service is busy. Try again in a minute.');
        }
        if (Errors.APIConnectionError && err instanceof Errors.APIConnectionError) {
          throw new Error('The AI service could not be reached. Try again shortly.');
        }
        if (Errors.APIError && err instanceof Errors.APIError) {
          throw new Error('The AI service answered with an error (' + err.status + '). Try again, or do it by hand.');
        }
        throw err;
      }
      if (response.stop_reason === 'refusal') {
        throw new Error('The AI declined that request. Do it by hand.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new Error('That request was too long to read. Ask for fewer things at once.');
      }
      const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error('The AI’s answer could not be read. Try again, or do it by hand.');
      }
    }
  };
}

module.exports = { aiService, MODEL };
