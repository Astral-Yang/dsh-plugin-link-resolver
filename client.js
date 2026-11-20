/**
 * dsh-plugin-link-resolver —— 客户端设置卡片。
 *
 * 通过 DSH 客户端原生 `ctx.configForms.get('link-resolver')` 读写插件配置，
 * 不依赖自定义 HTTP 路由；卡片注册在插件详情页的 `plugins.bundle.config` 插槽。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-link-resolver',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const FIELDS = [
      { key: 'downloadMedia', type: 'boolean', label: '下载媒体', hint: '开：解析后下载并在对话/IM 内自动交付；关：只解析元数据，不下载、不交付' },
      { key: 'audioOnly', type: 'boolean', label: '视频自动转音频', hint: '视频下载后另存一份 mp3，交付内容不变；需要 ffmpeg' },
      { key: 'audioOnlyPlatforms', type: 'list', label: '转音频平台', hint: '留空=全部启用平台；可选 bilibili, douyin, xiaohongshu, weibo, twitter, youtube, generic' },
      { key: 'toolEnabled', type: 'boolean', label: '注册 resolve_link 工具', hint: '默认关闭：链接由插件自动处理，模型无需重复解析；需要手动解析时才打开' },
      { key: 'retainDays', type: 'number', min: 1, max: 30, label: '下载保留天数 (1–30)', hint: '超过该天数的内容目录会被清理，并同步失效对应缓存' },
      {
        key: 'workspaceFilterMode',
        type: 'select',
        label: '工作区过滤',
        hint: 'allow：只处理列表内工作区；deny：跳过列表内工作区',
        options: [
          { value: 'deny', label: '跳过列表内（黑名单）' },
          { value: 'allow', label: '只处理列表内（白名单）' },
        ],
      },
      { key: 'workspaceList', type: 'list', label: '工作区路径', hint: '英文逗号分隔，按前缀匹配，例如 /home/me/work, /data/projects' },
      { key: 'downloadDir', type: 'string', label: '下载目录', hint: '相对会话工作区；绝对路径可直接使用' },
      { key: 'videoMaxHeight', type: 'number', min: 144, max: 4320, label: '视频最大高度 (px)' },
      { key: 'maxMedia', type: 'number', min: 1, max: 200, label: '最大媒体数量' },
      { key: 'maxDownloadMb', type: 'number', min: 0, max: 2000, label: '下载大小上限 (MB)' },
      { key: 'maxConcurrent', type: 'number', min: 1, max: 8, label: '最大并发数' },
      { key: 'resolveTimeoutMs', type: 'number', min: 1000, max: 120000, label: '解析超时 (ms)' },
      { key: 'downloadTimeoutMs', type: 'number', min: 1000, max: 1800000, label: '下载超时 (ms)' },
      { key: 'ffmpegPath', type: 'string', label: 'ffmpeg 路径' },
      { key: 'ytdlpPath', type: 'string', label: 'yt-dlp 路径' },
      { key: 'enabledPlatforms', type: 'list', label: '启用平台', hint: '英文逗号分隔：bilibili, douyin, xiaohongshu, weibo, twitter, youtube' },
      { key: 'biliCookies', type: 'string', label: 'B站 Cookie（可选）', hint: '形如 SESSDATA=...；留空为未登录，画质上限 480P' },
      { key: 'weiboCookies', type: 'string', label: '微博 Cookie（可选）' },
      { key: 'xhsCookies', type: 'string', label: '小红书 Cookie（可选）' },
    ];

    const styles = {
      wrap: { maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0 8px' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      intro: { margin: 0, opacity: 0.65, fontSize: '13px', lineHeight: 1.6 },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { fontSize: '12px', opacity: 0.55 },
      input: { padding: '7px 10px', borderRadius: '8px', border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', fontSize: '13px' },
      footer: { display: 'flex', gap: '10px', alignItems: 'center' },
      button: { padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#247bbf', color: '#fff', cursor: 'pointer', fontSize: '13px' },
      status: { fontSize: '12px', opacity: 0.7 },
    };

    /** 列表文本 → 数组（英文逗号分隔）。 */
    function parseList(text) {
      return text.split(',').map((item) => item.trim()).filter(Boolean);
    }

    /**
     * list 字段输入框。
     *
     * 受控输入如果每次按键都用数组 join 回填，末尾的逗号会被 filter 掉，
     * 导致根本无法输入第二个元素；这里保留原始文本，只把解析结果向上传。
     */
    function ListInput(props) {
      const { value, disabled, onChange } = props;
      const format = (list) => (Array.isArray(list) ? list.join(', ') : '');
      const [text, setText] = React.useState(() => format(value));
      React.useEffect(() => {
        setText((prev) => (parseList(prev).join('\u0000') === parseList(format(value)).join('\u0000') ? prev : format(value)));
      }, [value]);
      return h('input', {
        style: styles.input,
        type: 'text',
        value: text,
        disabled,
        onChange: (event) => {
          const next = event.target.value;
          setText(next);
          onChange(parseList(next));
        },
      });
    }

    /** 一个字段的编辑控件。 */
    function Field(props) {
      const { field, value, disabled, onChange } = props;
      if (field.type === 'select') {
        return h(
          'select',
          { style: styles.input, value: value ?? field.options[0].value, disabled, onChange: (event) => onChange(event.target.value) },
          ...field.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        );
      }
      if (field.type === 'boolean') {
        return h('input', { type: 'checkbox', checked: Boolean(value), disabled, onChange: (event) => onChange(event.target.checked) });
      }
      if (field.type === 'list') {
        return h(ListInput, { value, disabled, onChange });
      }
      const shown = value ?? '';
      return h('input', {
        style: styles.input,
        type: field.type === 'number' ? 'number' : 'text',
        ...(field.type === 'number' && field.min !== undefined ? { min: field.min } : {}),
        ...(field.type === 'number' && field.max !== undefined ? { max: field.max } : {}),
        value: shown,
        disabled,
        onChange: (event) =>
          onChange(
            field.type === 'number' ? Number(event.target.value) : event.target.value,
          ),
      });
    }

    /** 设置卡片主体。 */
    function SettingsPanel(props) {
      const form = props.form;
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [draft, setDraft] = React.useState(() => ({ ...(form.getSnapshot().value ?? {}) }));
      const [status, setStatus] = React.useState('');
      const [saving, setSaving] = React.useState(false);

      React.useEffect(() => {
        const unsubscribe = form.subscribe(() => {
          const next = form.getSnapshot();
          setSnapshot(next);
          if (next.status === 'ready' && next.value) setDraft({ ...next.value });
        });
        return unsubscribe;
      }, [form]);

      const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

      const save = async () => {
        setSaving(true);
        setStatus('');
        try {
          const base = snapshot.value ?? {};
          const changed = Object.keys(draft).filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(base[key]));
          if (changed.length === 0) {
            setStatus('没有修改');
            return;
          }
          const invalid = changed.filter((key) => {
            const field = FIELDS.find((entry) => entry.key === key);
            if (!field || field.type !== 'number') return false;
            const value = draft[key];
            return (
              typeof value !== 'number' ||
              !Number.isFinite(value) ||
              (field.min !== undefined && value < field.min) ||
              (field.max !== undefined && value > field.max)
            );
          });
          if (invalid.length > 0) {
            setStatus(`取值超出范围，未保存：${invalid.join('、')}`);
            return;
          }
          const results = await Promise.all(
            changed.map(async (key) => ({ key, ok: await form.set(key, draft[key]) })),
          );
          const failed = results.filter((entry) => !entry.ok).map((entry) => entry.key);
          setStatus(failed.length > 0 ? `保存失败：${failed.join('、')}（其余字段已生效）` : '已保存，立即生效');
        } catch (error) {
          setStatus(`保存失败：${String(error)}`);
        } finally {
          setSaving(false);
        }
      };

      if (snapshot.status === 'unavailable') {
        return h('div', { style: styles.wrap }, h('p', { style: styles.intro }, '设置服务不可用：请确认 dsh-client-ui-settings 已加载。'));
      }
      if (snapshot.status === 'loading' || !snapshot.value) {
        return h('div', { style: styles.wrap }, h('p', { style: styles.intro }, '加载配置中…'));
      }

      return h(
        'div',
        { style: styles.wrap },
        h('h3', { style: styles.title }, '链接解析'),
        h('p', { style: styles.intro }, '配置 dsh-plugin-link-resolver：自动解析、下载与交付；模型只负责播报结果。修改保存后立即生效。'),
        ...FIELDS.map((field) =>
          h(
            'div',
            { key: field.key, style: styles.row },
            h('label', { style: styles.label }, field.label),
            h(Field, { field, value: draft[field.key], disabled: !snapshot.writable || saving, onChange: (value) => update(field.key, value) }),
            field.hint ? h('span', { style: styles.hint }, field.hint) : null,
          ),
        ),
        h(
          'div',
          { style: styles.footer },
          h('button', { style: styles.button, disabled: saving || !snapshot.writable, onClick: save }, saving ? '保存中…' : '保存'),
          status ? h('span', { style: styles.status }, status) : null,
          !snapshot.writable ? h('span', { style: styles.status }, '当前 profile 不支持写入') : null,
        ),
      );
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const card = (slotProps) => {
          if (slotProps && slotProps.view === 'summary') {
            return h('div', { style: { fontSize: '12px', opacity: 0.7 } }, '链接解析：自动解析、下载与交付');
          }
          return h(SettingsPanel, { form: ctx.configForms.get('link-resolver') });
        };

        try {
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-plugin-link-resolver' }, card),
          );
        } catch {}
        try {
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-plugin-link-resolver#link-resolver' }, card),
          );
        } catch {}
      },
    };
  },
});