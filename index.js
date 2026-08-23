// 大纲引导扩展（无 UI 纯后台版）
// 对应设计文档《后台大纲指导-设计文档.md》第十部分
//
// 功能：
//   ① 自动提取【大纲修改】块 → 写入世界书条目「大纲·当前」
//   ② 检测"重写大纲"消息 → 读取启用中的原生大纲条目 → 追加【续写材料】块
//   ③ 标题行点击折叠（纯视觉）
//   ④ manifest.json 声明，加载后出现在酒馆「扩展」面板
//
// 注意：
//   - API 名/路径按 SillyTavern 1.12 系编写，开发前按锁定的 ST 版本核对
//   - 本扩展不做任何 UI（无侧面板、无按钮）；重写按钮用快捷指令实现
//   - 条目格式是协议：脚本按「大纲·当前」三字段格式解析，玩家手改条目也须保持同格式

import { eventSource, event_types } from '../../script.js';
import { getWorldInfo, setWorldInfo } from '../../endpoints/world-info.js';

// ============ 常量：条目识别（与设计文档一致） ============

// 「大纲·当前」条目：content 以【用户偏好：开头
const ENTRY_CURRENT_PREFIX = '【用户偏好：';
// 「旧大纲·存档」条目：content 以【旧1】开头
const ENTRY_ARCHIVE_PREFIX = '【旧1】';
// 规则条目：content 以【后台大纲引导】开头
const ENTRY_RULE_PREFIX = '【后台大纲引导】';

// ============ 工具函数 ============

/** 查找指定前缀的条目 */
function findEntry(wi, prefix) {
    return (wi.entries || []).find(e => e.content.startsWith(prefix));
}

/** 按字段名替换「大纲·当前」条目内容 */
function setField(content, field, value) {
    if (field === '用户偏好' || field === '用户雷点') {
        // 单行字段：替换到下一个【 或行尾
        const re = new RegExp(`【${field}：[^】]*】`);
        return content.replace(re, `【${field}：${value}】`);
    }
    if (field === '大纲正文') {
        // 正文字段：多行，直到条目末尾
        const re = new RegExp('【大纲正文：[\\s\\S]*】');
        return content.replace(re, `【大纲正文：\n${value}\n】`);
    }
    return content;
}

/** 解析【大纲修改】块内的字段 */
function parseModifyBlock(block) {
    const fields = {};
    let m;
    // 偏好 / 雷点：单行
    if ((m = block.match(/偏好[：:]\s*([^\n]*)/))) fields.偏好 = m[1].trim();
    if ((m = block.match(/雷点[：:]\s*([^\n]*)/))) fields.雷点 = m[1].trim();
    // 正文：多行，直到下一个字段行或块尾
    if ((m = block.match(/正文[：:]\s*([\s\S]*?)(?=\n(?:偏好|雷点)[：:]|$)/))) fields.正文 = m[1].trim();
    return fields;
}

// ============ 功能① + 功能②：发送拦截 ============

eventSource.on(event_types.MESSAGE_SENT, async (chat, msgId) => {
    if (!chat || chat.length === 0) return;
    const mes = chat[chat.length - 1];
    // 只处理玩家消息
    if (!mes || !mes.is_user) return;

    const text = mes.mes || '';
    const wi = getWorldInfo();
    if (!wi || !wi.entries) return;
    let dirty = false;

    // ---- 功能①：自动提取【大纲修改】块 ----
    const modifyMatch = text.match(/【大纲修改】([\s\S]*?)【\/大纲修改】/);
    if (modifyMatch) {
        const fields = parseModifyBlock(modifyMatch[1]);
        const entry = findEntry(wi, ENTRY_CURRENT_PREFIX);
        if (entry && Object.keys(fields).length > 0) {
            let content = entry.content;
            if (fields.偏好 !== undefined) content = setField(content, '用户偏好', fields.偏好);
            if (fields.雷点 !== undefined) content = setField(content, '用户雷点', fields.雷点);
            if (fields.正文 !== undefined) content = setField(content, '大纲正文', fields.正文);
            entry.content = content;
            dirty = true;
        }
    }

    // ---- 功能②：检测"重写大纲" → 拼续写材料 ----
    if (text.includes('重写大纲')) {
        // 原生大纲条目 = 当前启用中、且不属于本系统三条目的条目
        const nativeEntries = wi.entries.filter(e =>
            !e.disable &&
            !e.content.startsWith(ENTRY_CURRENT_PREFIX) &&
            !e.content.startsWith(ENTRY_ARCHIVE_PREFIX) &&
            !e.content.startsWith(ENTRY_RULE_PREFIX)
        );
        if (nativeEntries.length > 0) {
            const material = nativeEntries.map(e => e.content).join('\n---\n');
            // 追加到玩家消息末尾；上下文构建发生在 MESSAGE_SENT 之后，模型能看到材料
            mes.mes = text + '\n【续写材料】\n' + material + '\n【/续写材料】';
            // 注：不刷新 DOM——玩家界面保持原文，材料仅对模型可见。
            // 若希望界面同步，可在此重渲染该消息（按锁定版本适配）。
        }
    }

    if (dirty) setWorldInfo(wi);
});

// ============ 功能③：标题行点击折叠（纯视觉） ============

// 渲染后，把消息末尾的"大纲：……"标题行 span 化，点击切换大纲栏展开/收起
eventSource.on(event_types.MESSAGE_RENDERED, (msgId) => {
    if (typeof msgId === 'undefined') return;
    const $mes = $(`.mes[data-message-id="${msgId}"]`);
    if (!$mes.length) return;
    const $text = $mes.find('.mes_text');
    if (!$text.length) return;

    const html = $text.html();
    if (!html.includes('大纲：')) return;

    // 标题行 = 第一个"大纲："出现处到该行换行；其后到消息末尾 = 大纲栏展开内容
    const idx = html.indexOf('大纲：');
    const lineEnd = html.indexOf('<br>', idx);
    const titleHtml = lineEnd < 0 ? html.slice(idx) : html.slice(idx, lineEnd);
    const bodyHtml = lineEnd < 0 ? '' : html.slice(lineEnd + 4);

    // 包成可折叠结构（首次处理才做，避免重复包裹）
    if (!$text.find('.dg-title').length) {
        $text.html(
            html.slice(0, idx) +
            `<span class="dg-title" style="cursor:pointer;color:var(--primary-color);user-select:none;">${titleHtml} ▸</span>` +
            `<div class="dg-body" style="display:none;">${bodyHtml}</div>`
        );
    }
});

// 委托绑定点击（只绑一次，避免重复）
$(document).on('click', '.dg-title', function () {
    $(this).toggleClass('open');
    $(this).text($(this).text().replace(' ▸', '').replace(' ▾', '') + ($(this).hasClass('open') ? ' ▾' : ' ▸'));
    $(this).closest('.mes_text').find('.dg-body').toggle();
});
