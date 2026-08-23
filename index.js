// 大纲引导扩展（无 UI 纯后台版）
// 对应设计文档《后台大纲指导-设计文档.md》第十部分
//
// 功能：
//   ① 自动提取【大纲修改】块 → 写入世界书条目「大纲·当前」
//   ② 检测"重写大纲"消息 → 读取启用中的原生大纲条目 → 追加【续写材料】块
//   （大纲栏的折叠/展开由 HTML <details> 组件原生实现，扩展不再处理）
//
// 注意：
//   - API 名/路径按 SillyTavern 1.12 系编写，开发前按锁定的 ST 版本核对
//   - 本扩展不做任何 UI（无侧面板、无按钮）；重写按钮用快捷指令实现
//   - 条目格式是协议：脚本按「大纲·当前」三字段格式解析，玩家手改条目也须保持同格式
//   - 加载位置兼容：Git URL 安装落在 extensions/thirdparty/<名>/（上3级），
//     手动拷贝到 extensions/<名>/（上2级）也能加载——见下方动态 import 容错

// ============ 动态 import（兼容两种扩展目录深度） ============

// extensions/thirdparty/-/index.js → ../../../script.js
// extensions/-/index.js            → ../../script.js
let scriptApi, worldInfoApi;
try {
    scriptApi = await import('../../../script.js');
} catch {
    scriptApi = await import('../../script.js');
}
try {
    worldInfoApi = await import('../../../endpoints/world-info.js');
} catch {
    worldInfoApi = await import('../../endpoints/world-info.js');
}

const { eventSource, event_types } = scriptApi;
const { getWorldInfo, setWorldInfo } = worldInfoApi;

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
    if (!chat || !Array.isArray(chat) || chat.length === 0) return;
    // 用 msgId 索引取刚发送的消息（不能依赖 chat 最后一条）
    const mes = chat[msgId];
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
        }
    }

    if (dirty) await setWorldInfo(wi);
});
