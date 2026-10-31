'use strict';

/**
 * VSS Bridge - AI check-in comments.
 *
 * Turns "VSS version vs your file" into a one-line check-in comment through the
 * provider you configured: any OpenAI-compatible API (OpenAI, OpenRouter, Groq,
 * DeepSeek, Ollama, LM Studio...), Anthropic, Azure OpenAI or Google Gemini.
 * Plain Node http(s): VS Code 1.70 has no global fetch, and VS Code routes these
 * modules through its proxy settings.
 */

const http = require('http');
const https = require('https');

const FILE_LIMIT = 12000;  // chars of changes sent per file
const TOTAL_LIMIT = 40000; // chars sent per request
const CONTEXT = 3;         // unchanged lines kept around a change
const TIMEOUT_MS = 60000;

const SYSTEM_PROMPT =
  'You write Visual SourceSafe check-in comments. You get the changes a developer made, per file, ' +
  'as the old ("--- before") and new ("+++ after") text of the changed region. ' +
  'Write a detailed summary in English: what was newly added, what was removed, what was changed, ' +
  'and explain why or what it does when the code shows it. Name the files, functions and fields involved. ' +
  'VSS keeps the comment on one line, so reply with ONE line in this form, leaving out parts that are empty: ' +
  'Added: ...; Removed: ...; Changed: ...; Why: ... ' +
  'At most 600 characters. No quotes, no markdown, no prefix like "Comment:".';

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + '\n... (cut)' : text;
}

/**
 * What changed in one file: lines shared at the start and end are dropped, the
 * changed middle (plus a little context) is sent as before / after.
 * Returns null when nothing changed.
 * shortcut: prefix/suffix trim, not a real diff - edits at both ends of a big file
 * send everything between them; switch to a line diff if requests get too big.
 */
function describeChange(name, before, after) {
  if (before.includes(0) || after.includes(0)) {
    return before.equals(after) ? null : `### ${name}\n(binary file changed)`;
  }
  const a = before.toString('utf8').split(/\r?\n/);
  const b = after.toString('utf8').split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
  if (start === a.length && start === b.length) { return null; }
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) { end++; }
  start = Math.max(0, start - CONTEXT);
  end = Math.max(0, end - CONTEXT);
  return clip(`### ${name} (from line ${start + 1})\n` +
    `--- before\n${a.slice(start, a.length - end).join('\n')}\n` +
    `+++ after\n${b.slice(start, b.length - end).join('\n')}`, FILE_LIMIT);
}

/** { url, headers, body } of the chat request for `ai` = { provider, endpoint, model }. */
function buildRequest(ai, key, text) {
  const endpoint = (ai.endpoint || '').trim().replace(/\/+$/, '');
  const model = (ai.model || '').trim();
  if (ai.provider === 'azure' && !endpoint) {
    throw new Error('set vssBridge.ai.endpoint to the full chat completions URL from the Azure portal.');
  }
  if (ai.provider !== 'azure' && !model) { throw new Error('set the model name in vssBridge.ai.model.'); }
  const headers = { 'Content-Type': 'application/json' };

  if (ai.provider === 'anthropic') {
    if (key) { headers['x-api-key'] = key; }
    headers['anthropic-version'] = '2023-06-01';
    return {
      url: /\/v1\/messages$/.test(endpoint) ? endpoint : (endpoint || 'https://api.anthropic.com') + '/v1/messages',
      headers,
      body: { model, max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: text }] }
    };
  }
  if (ai.provider === 'gemini') {
    if (key) { headers['x-goog-api-key'] = key; }
    return {
      url: `${endpoint || 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(model)}:generateContent`,
      headers,
      body: { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: 'user', parts: [{ text }] }] }
    };
  }
  // OpenAI-compatible; Azure takes the URL as pasted from its portal and an api-key header.
  if (key) { Object.assign(headers, ai.provider === 'azure' ? { 'api-key': key } : { Authorization: 'Bearer ' + key }); }
  const body = { messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }] };
  if (model) { body.model = model; }
  return {
    url: ai.provider === 'azure' || /\/chat\/completions$/.test(endpoint)
      ? endpoint : (endpoint || 'https://api.openai.com/v1') + '/chat/completions',
    headers,
    body
  };
}

/** The comment from a provider's JSON reply, as one clean line. */
function readReply(provider, json) {
  let text = '';
  try {
    text = provider === 'anthropic' ? json.content.filter(p => p.type === 'text').map(p => p.text).join('')
      : provider === 'gemini' ? json.candidates[0].content.parts.filter(p => !p.thought).map(p => p.text || '').join('')
      : json.choices[0].message.content;
  } catch (e) { /* unexpected shape - reported as empty below */ }
  const line = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '') // reasoning models served through Ollama / OpenRouter
    .replace(/\s+/g, ' ').trim()
    .replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!line) { throw new Error('the AI returned an empty reply.'); }
  return line;
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = (url.startsWith('http:') ? http : https).request(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(data) }, headers),
      timeout: TIMEOUT_MS
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON - shown raw below */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) { resolve(json); return; }
        const msg = json && json.error ? (json.error.message || JSON.stringify(json.error)) : text.slice(0, 300);
        reject(new Error(`${res.statusCode} ${msg}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} seconds.`)));
    req.on('error', reject);
    req.end(data);
  });
}

/** One-line check-in comment for `changes` (strings from describeChange). */
async function generateComment(ai, key, changes) {
  const req = buildRequest(ai, key, clip(changes.join('\n\n'), TOTAL_LIMIT));
  return readReply(ai.provider, await post(req.url, req.headers, req.body));
}

module.exports = { describeChange, buildRequest, readReply, generateComment };
