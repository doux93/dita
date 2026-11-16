'use strict';
(function (root) {
  async function generate({ api, manuals, model, force = false, signal, current = () => true, onProgress = () => {} }) {
    const data = root.DitaKnowledgeSemantic, indexes = [], groups = [], warnings = [];
    const stats = { reusedManuals: 0, rebuiltManuals: 0, totalManuals: manuals.length, totalChunks: 0 };
    function active() { if (signal.aborted || !current()) throw Object.assign(Error('已取消向量生成'), { name: 'AbortError' }); }
    for (const [position, manual] of manuals.entries()) {
      active(); onProgress({ ...stats, position: position + 1, manual: manual.title });
      const records = manual.entries.map(entry => ({ ...entry, manualId: manual.id, manualTitle: manual.title }));
      const response = await api.request('/api/knowledge/semantic', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manual: { id: manual.id, title: manual.title, entries: manual.entries }, model, force, profile: data.PROFILE.id }), signal });
      if (!response.ok) throw Error(await api.error(response));
      if (!response.body) throw Error('向量生成响应不完整，请重试');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', received = 0, result;
      function consume(line) {
        active(); let value;
        try { value = JSON.parse(line); } catch (cause) { throw Error('向量生成响应格式无效，请重试', { cause }); }
        if (result) throw Error('向量生成响应包含重复结果');
        if (value.type === 'error') throw Error(value.message || '向量生成失败');
        if (value.type === 'result') {
          if (!['cache', 'generated', 'embedded'].includes(value.source) || !Array.isArray(value.warnings) || value.warnings.some(item => typeof item !== 'string') || value.index?.profile?.id !== data.PROFILE.id) throw Error('向量生成响应不兼容，请刷新工作台后重试');
          data.validate(records, value.index); result = value;
        } else if (value.type === 'progress') onProgress({ ...stats, position: position + 1, manual: manual.title, done: value.done, total: value.total });
        else throw Error('向量生成响应格式无效，请重试');
      }
      try {
        while (true) {
          active(); const { done, value } = await reader.read(); active();
          if (done) { pending += decoder.decode(); break; }
          received += value.byteLength; if (received > 128 * 1024 * 1024) throw Error('单份手册向量响应过大，请减少发布范围');
          pending += decoder.decode(value, { stream: true });
          let end; while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) consume(line); }
        }
        if (pending.trim()) consume(pending);
        if (!result) throw Error('向量生成中断，未收到完整结果，请重试');
      } finally { await reader.cancel().catch(cause => console.warn('向量响应读取器关闭失败', cause.name)); reader.releaseLock(); }
      active(); groups.push(records); indexes.push(result.index); warnings.push(...result.warnings);
      stats[result.source === 'generated' ? 'rebuiltManuals' : 'reusedManuals']++; stats.totalChunks += result.index.chunks.length;
      if (stats.totalChunks > 12000) throw Error('语义索引超过 12000 个片段，请减少手册后重试');
      onProgress({ ...stats, position: position + 1, manual: manual.title, source: result.source });
    }
    active(); return { index: data.combineIndexes(groups, indexes), stats, warnings: [...new Set(warnings)] };
  }
  root.DitaKnowledgeIndex = { generate };
})(window);
