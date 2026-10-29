/**
 * server/ai.js, without the network: off without a key and saying why; the request it sends
 * (the model, the fallback, low effort, the JSON schema, the instructions and the words); the
 * answer read back; a refusal, a cut-off answer, unreadable JSON and the API's own errors each
 * turned into words a person can act on.
 *
 *   node tests/ai-service-test.js
 */
const path = require('path');
const { aiService, MODEL } = require(path.join(__dirname, '..', 'server', 'ai.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};
const refused = async (fn, re) => {
  try { await fn(); return 'not refused'; } catch (e) { return re.test(e.message) ? true : e.message; }
};
const fake = (answer) => {
  const sent = [];
  return {
    sent,
    beta: { messages: { create: async (body) => { sent.push(body); if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(body) : answer; } } }
  };
};
const reply = (obj, extra) => Object.assign({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] }, extra || {});

(async () => {
  console.log('OFF WITHOUT A KEY');
  const none = aiService({ env: {} });
  ok('off, and says where the key goes', none.enabled === false && /ANTHROPIC_API_KEY/.test(none.reason));
  ok('and asking it says so', await refused(() => none.propose({}), /ANTHROPIC_API_KEY/));
  ok('a blank key is no key', aiService({ env: { ANTHROPIC_API_KEY: '  ' } }).enabled === false);

  console.log('\nTHE REQUEST');
  const schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
  const c = fake(reply({ reply: 'One task.', actions: [] }));
  const svc = aiService({ client: c });
  const got = await svc.propose({ system: 'You read requests.', text: 'Today is Thursday. Remind Priya.', schema });
  const body = c.sent[0];
  ok('the current Opus', body.model === 'claude-opus-5-5' && MODEL === 'claude-opus-5-5' && svc.model === MODEL);
  ok('a declined request falls back by itself', body.fallbacks === 'default' && JSON.stringify(body.betas) === '["server-side-fallback-2026-07-01"]');
  ok('low effort, the answer held to the schema', body.output_config.effort === 'low' && body.output_config.format.type === 'json_schema' &&
    body.output_config.format.schema === schema);
  ok('the instructions and the words, nothing else', body.system === 'You read requests.' && body.messages.length === 1 &&
    body.messages[0].role === 'user' && body.messages[0].content === 'Today is Thursday. Remind Priya.');
  ok('room to think and answer', body.max_tokens >= 16000 && body.thinking === undefined && body.temperature === undefined);
  ok('the answer read back', got.reply === 'One task.' && Array.isArray(got.actions));

  console.log('\nWHEN IT DOES NOT ANSWER');
  ok('a refusal', await refused(() => aiService({ client: fake(reply({}, { stop_reason: 'refusal' })) }).propose({ schema }), /declined that request/));
  ok('cut off', await refused(() => aiService({ client: fake(reply({}, { stop_reason: 'max_tokens' })) }).propose({ schema }), /too long/));
  ok('unreadable', await refused(() => aiService({ client: fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{nope' }] }) }).propose({ schema }), /could not be read/));
  let Anthropic = null;
  try { const m = require(path.join(__dirname, '..', 'server', 'node_modules', '@anthropic-ai', 'sdk')); Anthropic = m.default || m; } catch (e) { Anthropic = null; }
  if (Anthropic) {
    const mk = (Cls, status) => new Cls(status, { type: 'error', error: { message: 'x' } }, 'x', new Headers());
    ok('a key not accepted', await refused(() => aiService({ client: fake(mk(Anthropic.AuthenticationError, 401)) }).propose({ schema }), /key was not accepted/));
    ok('busy', await refused(() => aiService({ client: fake(mk(Anthropic.RateLimitError, 429)) }).propose({ schema }), /busy/));
    ok('another error, with its status', await refused(() => aiService({ client: fake(mk(Anthropic.InternalServerError, 500)) }).propose({ schema }), /error \(500\)/));
    ok('with a key, the real client is made', aiService({ env: { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' } }).enabled === true);
  } else {
    ok('the SDK is installed in server/', false, 'npm install in server/');
  }

  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
