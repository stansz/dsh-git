/**
 * dsh-git — browser half.
 *
 * Registers this row's Configure page into the Plugins page's `plugins.row.config`
 * slot, keyed `<package name>#<row id>`. Values and writes come from the Host through
 * the `form` prop; this file renders controls and decides nothing.
 *
 * Hand-written in the loader's bundle format on purpose: the Host serves built
 * `lib/client.js`, this needs nothing beyond baseline React, and so it carries no
 * build step and declares no `dsh.client.external` requests.
 *
 * Loader contract: window.__ModuleLoader__.load({ id: <package name>, factory(require) })
 * The factory returns the module exports; `apply` runs inside the browser plugin
 * context and `inject` names the services it needs.
 *
 * Nothing here is allowed to throw its way out: a component that throws blanks its
 * slot entry, and the previous attempt at this page is remembered for being worse than
 * blank. Every read is optional-chained, every value has a fallback, and the two states
 * this page cannot fix — no form served, and a read-only form — are rendered as
 * explanations rather than as an empty page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-git',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /** The Host entry id this page configures (the patch row's id). */
    const NS = 'dsh-git';
    /** The row's own `plugins.row.config` cell. */
    const SLOT_KEY = 'dsh-git#dsh-git';
    /** The DSH release this bundle was verified against. */
    const TESTED_DSH_VERSION = '0.2.0-rc.2';

    /**
     * The controls, in the order the page shows them.
     *
     * `path` is the Host schema key, and the whole set is compared against the Host's
     * `SETTINGS_KEYS` by test/client-half.test.mjs — this bundle cannot import the Host
     * module, so nothing else keeps the form and the schema from drifting apart.
     * `fallback` is what the control shows when no layer supplies a value.
     */
    const GROUPS = [
      {
        title: 'Plain mode',
        fields: [
          {
            path: 'plainMode',
            kind: 'switch',
            fallback: false,
            label: 'Plain mode — the tool, without the rules',
            note: 'No edit is refused, nothing is committed or pushed automatically, and no branch is protected, so a push to main needs no flag. The guard is not affected: raw git in bash is still refused and redirected at the tool. The settings below are ignored while this is on.',
          },
        ],
      },
      {
        title: 'Worktrees',
        fields: [
          {
            path: 'autoWorktree',
            kind: 'select',
            fallback: 'protected',
            options: [
              { value: 'protected', label: 'protected — refuse an edit to a repository on a protected branch' },
              { value: 'always', label: 'always — every repository this session changes needs a worktree' },
              { value: 'off', label: 'off — never refuse an edit' },
            ],
            note: 'A refusal names action "start". Work on main is never refused in a repository with no commits yet.',
          },
          { path: 'worktreeRoot', kind: 'text', fallback: '', placeholder: '<session workspace>/.worktrees', note: 'Empty derives it from the session workspace. Keep it outside every repository.' },
        ],
      },
      {
        title: 'The automatic sync',
        fields: [
          { path: 'turnCommit', kind: 'switch', fallback: true, label: 'Commit each turn\'s changes' },
          { path: 'turnPush', kind: 'switch', fallback: true, label: 'Push each turn when the branch is safe' },
          { path: 'turnSyncScope', kind: 'select', fallback: 'session', options: [
            { value: 'session', label: 'session — only repositories this session changed' },
            { value: 'workspace', label: 'workspace — every dirty repository under the working directory' },
          ] },
          { path: 'turnCommitMaxFiles', kind: 'number', fallback: 200, label: 'Skip the automatic commit above this many changed paths' },
          { path: 'turnSyncTimeoutMs', kind: 'number', fallback: 20000, label: 'Budget for one end-of-turn sync (ms)' },
          { path: 'turnCommitMessage', kind: 'text', fallback: '', placeholder: 'dsh: turn {turn} — {paths}', label: 'Automatic commit message' },
        ],
      },
      {
        title: 'Branches and pushing',
        fields: [
          { path: 'protectedBranches', kind: 'list', fallback: ['main', 'master'], label: 'Protected branch names', note: 'This plugin\'s own list, matched literally — not GitHub branch protection. One list, two rules: never pushed automatically, and never edited in place. Listing a name replaces the default rather than extending it.' },
          { path: 'branchPrefix', kind: 'text', fallback: 'dsh/', label: 'Task branch prefix' },
          { path: 'baseBranch', kind: 'text', fallback: '', placeholder: 'origin/HEAD, then main', label: 'Base branch' },
        ],
      },
      {
        title: 'The guard',
        fields: [
          { path: 'guardMode', kind: 'select', fallback: 'redirect', options: [
            { value: 'redirect', label: 'redirect — refuse raw mutating git and name the tool action' },
            { value: 'warn', label: 'warn — classify and allow (a diagnostic)' },
            { value: 'off', label: 'off — no guard: bash git runs unopposed and this plugin is bypassed' },
          ], note: 'The guard is what keeps the git tool the way work gets done here. Turning it off does not make the tool unsafe; it makes it optional.' },
          { path: 'guardAsk', kind: 'select', fallback: 'ask', options: [
            { value: 'ask', label: 'ask — leave an unclassifiable command to a person' },
            { value: 'deny', label: 'deny — refuse it, for a deployment with nobody at the prompt' },
            { value: 'allow', label: 'allow — accept it' },
          ] },
          { path: 'guardTools', kind: 'list', fallback: ['bash', 'pwsh'], label: 'Tools the guard inspects' },
        ],
      },
      {
        title: 'GitHub',
        fields: [
          { path: 'githubHost', kind: 'text', fallback: 'github.com', label: 'GitHub host (GitHub Enterprise)' },
          { path: 'prDraft', kind: 'switch', fallback: false, label: 'Open pull requests as drafts by default' },
        ],
      },
      {
        title: 'Advanced',
        fields: [
          { path: 'stateRoot', kind: 'text', fallback: '', label: 'Session state directory', note: 'Ownership records and push backoff. Never holds credentials.' },
          { path: 'timeoutMs', kind: 'number', fallback: 30000, label: 'Deadline for one git command (ms)' },
        ],
      },
    ];

    /** Every schema key this page offers a control for, in page order. */
    const FIELD_PATHS = GROUPS.reduce((all, group) => all.concat(group.fields.map((field) => field.path)), []);

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '620px' },
      group: { display: 'flex', flexDirection: 'column', gap: '12px' },
      groupTitle: { margin: 0, fontSize: '13px', fontWeight: 600, lineHeight: '20px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '13px', lineHeight: '20px' },
      control: {
        fontSize: '13px',
        lineHeight: '20px',
        padding: '6px 8px',
        borderRadius: '8px',
        border: '0.5px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.95,
        width: '100%',
        boxSizing: 'border-box',
      },
      switchRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      note: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.6 },
      error: { margin: 0, fontSize: '12px', lineHeight: '18px' },
      alert: { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 500 },
      summary: { fontSize: '13px', opacity: 0.75 },
    };

    /** The effective value: the decoded value, then the user layer, then the patch layer. */
    function valueOf(state, field) {
      const layers = [state?.value, state?.user, state?.base];
      for (const layer of layers) {
        const candidate = layer === undefined || layer === null ? undefined : layer[field.path];
        if (candidate !== undefined && candidate !== null) return candidate;
      }
      return field.fallback;
    }

    function listToText(value) {
      return Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }

    function textToList(value) {
      return String(value ?? '').split(/[\s,]+/u).map((entry) => entry.trim()).filter((entry) => entry !== '');
    }

    /** One field, with its label, control and note. */
    function Field(props) {
      const { field, value, disabled, onWrite } = props;
      const control = (() => {
        if (field.kind === 'switch') {
          return React.createElement('input', {
            type: 'checkbox',
            role: 'switch',
            'aria-checked': value === true,
            checked: value === true,
            disabled,
            onChange: (event) => onWrite(event.target.checked),
          });
        }
        if (field.kind === 'select') {
          return React.createElement(
            'select',
            { style: styles.control, value: String(value ?? ''), disabled, onChange: (event) => onWrite(event.target.value) },
            (field.options ?? []).map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
          );
        }
        if (field.kind === 'number') {
          return React.createElement('input', {
            type: 'number',
            style: styles.control,
            defaultValue: String(value ?? ''),
            disabled,
            onBlur: (event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(parsed)) onWrite(parsed);
            },
          });
        }
        if (field.kind === 'list') {
          return React.createElement('input', {
            type: 'text',
            style: styles.control,
            defaultValue: listToText(value),
            disabled,
            onBlur: (event) => onWrite(textToList(event.target.value)),
          });
        }
        return React.createElement('input', {
          type: 'text',
          style: styles.control,
          defaultValue: String(value ?? ''),
          placeholder: field.placeholder,
          disabled,
          onBlur: (event) => onWrite(event.target.value),
        });
      })();

      const label = field.label ?? field.path;
      return React.createElement(
        'div',
        { style: styles.field },
        field.kind === 'switch'
          ? React.createElement('label', { style: styles.switchRow }, control, React.createElement('span', { style: styles.label }, label))
          : React.createElement('span', { style: styles.label }, label),
        field.kind === 'switch' ? null : control,
        field.note === undefined ? null : React.createElement('p', { style: styles.note }, field.note),
      );
    }

    /**
     * The row's Configure page.
     *
     * `view: 'summary'` is the one-liner the Plugins list shows; `view: 'page'` is the
     * page itself. Both mount unconditionally: a page whose Host half is missing is
     * exactly the state this exists to report, so it is never hidden behind a gate.
     */
    function ConfigPage(props) {
      const { view, form } = props;
      const state = form?.state;
      const [error, setError] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const writable = state?.writable !== false;
      const autoWorktree = valueOf(state, { path: 'autoWorktree', fallback: 'protected' });
      const turnPush = valueOf(state, { path: 'turnPush', fallback: true });
      const plainMode = valueOf(state, { path: 'plainMode', fallback: false }) === true;

      if (view === 'summary') {
        if (form === undefined) {
          return React.createElement('span', { style: styles.summary }, 'git · settings unavailable');
        }
        if (plainMode === true) {
          return React.createElement('span', { style: styles.summary }, 'git · plain mode');
        }
        return React.createElement('span', { style: styles.summary },
          'git · worktrees: ' + String(autoWorktree) + ' · auto-push: ' + (turnPush === true ? 'on' : 'off'));
      }

      if (form === undefined) {
        return React.createElement(
          'div',
          { style: styles.wrap },
          React.createElement('p', { style: styles.alert, role: 'alert' }, 'This page has no settings to show.'),
          React.createElement('p', { style: styles.note },
            'The Host did not serve this row\'s settings namespace, which happens when the Host half did not load '
              + 'or its Config schema is missing. The plugin still works with every setting at its default. '
              + 'Editing the row in cordis.patch.yml changes the same settings. (verified against DSH ' + TESTED_DSH_VERSION + ')'),
        );
      }

      const write = (path, value) => {
        if (typeof form.mutate !== 'function') return;
        setSaving(true);
        setError(null);
        Promise.resolve(form.mutate([{ op: 'set', path: [path], value }], state?.revision))
          .then((ok) => {
            if (ok === false) setError('The Host did not accept that change.');
          })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .then(() => setSaving(false));
      };

      return React.createElement(
        'div',
        { style: styles.wrap },
        writable
          ? null
          : React.createElement('p', { style: styles.note }, 'Read-only here: this row\'s configuration is pinned by a layer above this window.'),
        plainMode
          ? React.createElement('p', { style: styles.note },
            'Plain mode is on: autoWorktree, turnCommit, turnPush and protectedBranches are overridden while it is set.')
          : null,
        error === null ? null : React.createElement('p', { style: styles.error, role: 'alert' }, error),
        GROUPS.map((group) => React.createElement(
          'div',
          { key: group.title, style: styles.group },
          React.createElement('p', { style: styles.groupTitle }, group.title),
          group.fields.map((field) => React.createElement(Field, {
            key: field.path,
            field,
            value: valueOf(state, field),
            disabled: !writable || saving,
            onWrite: (value) => write(field.path, value),
          })),
        )),
      );
    }

    /**
     * Mount the row's Configure page.
     *
     * Deliberately not gated on the namespace being served: see `ConfigPage`.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({ name: 'plugins.row.config', key: SLOT_KEY }, ConfigPage),
          ),
        'dsh-git: configure page',
      );
    }

    const inject = ['slots'];

    exports.NS = NS;
    exports.SLOT_KEY = SLOT_KEY;
    exports.TESTED_DSH_VERSION = TESTED_DSH_VERSION;
    exports.GROUPS = GROUPS;
    exports.FIELD_PATHS = FIELD_PATHS;
    exports.ConfigPage = ConfigPage;
    exports.Field = Field;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
