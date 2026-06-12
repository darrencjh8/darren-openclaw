/**
 * Agent Orchestrator — LLM conversation loop with tool calling.
 * Ported 1:1 from src/agent/orchestrator.py
 */

import OpenAI from 'openai';
import { SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from './prompts.js';

const MAX_TOOL_ITERATIONS = 5;

export class DeepSeekClient {
  constructor(config) {
    this._client = new OpenAI({
      apiKey: config.deepseekApiKey,
      baseURL: 'https://api.deepseek.com/v1',
    });
    this._model = 'deepseek-chat';
  }

  _mergeReasoning(data) {
    for (const choice of data.choices || []) {
      const msg = choice.message || {};
      if (!msg.content && msg.reasoning_content) {
        msg.content = msg.reasoning_content;
      }
    }
  }

  async chat(messages, tools) {
    const kwargs = {
      model: this._model,
      messages,
      temperature: 0.1,
    };
    if (tools) {
      kwargs.tools = tools;
      kwargs.tool_choice = 'auto';
    }

    const retryDelays = [1000, 2000, 4000];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await Promise.race([
          this._client.chat.completions.create(kwargs, {
            body: { thinking: { type: 'adaptive' } },
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
        ]);
        const data = response._request_id ? response : response;
        this._mergeReasoning(data);
        return data;
      } catch (e) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
        } else {
          throw e;
        }
      }
    }
  }
}

export class AgentOrchestrator {
  constructor(config, tools) {
    this._config = config;
    this._llm = new DeepSeekClient(config);
    this._tools = tools;
  }

  get tools() { return this._tools; }

  async processEmail(msgId, rawEmail, imapHandler) {
    this._tools.setEmailContext(msgId, rawEmail, imapHandler);

    // Simple email text extraction (full extractors port in later task)
    let emailText = '';
    try {
      emailText = Buffer.from(rawEmail).toString('utf8');
    } catch {
      emailText = String(rawEmail);
    }

    const messages = this._buildMessages(emailText);
    const toolSchemas = this._tools.getToolSchemas();

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this._llm.chat(messages, toolSchemas);
      const choice = (response.choices || [{}])[0];
      const finishReason = choice.finish_reason;
      const message = choice.message || {};

      if (message.content) {
        messages.push({ role: 'assistant', content: message.content });
      }

      const toolCalls = message.tool_calls;
      if (!toolCalls) {
        if (finishReason === 'stop') {
          return { action: 'completed', details: message.content || '' };
        }
        return { action: 'error', details: `Unexpected finish_reason: ${finishReason}` };
      }

      const assistantMsg = { role: 'assistant', content: message.content, tool_calls: toolCalls };
      if (!assistantMsg.content) delete assistantMsg.content;
      messages.push(assistantMsg);

      for (const tc of toolCalls) {
        const func = tc.function || {};
        const name = func.name || '';
        let args = {};
        try { args = JSON.parse(func.arguments || '{}'); } catch {}

        const result = await this._tools.executeTool(name, args);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id || '',
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }

    return { action: 'error', details: 'Max tool iterations exceeded' };
  }

  _buildMessages(emailContent) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    for (const example of FEW_SHOT_EXAMPLES) {
      messages.push(...example);
    }
    messages.push({ role: 'user', content: `Process this email:\n\n${emailContent}` });
    return messages;
  }
}
