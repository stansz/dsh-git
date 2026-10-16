/**
 * dsh-git — browser half.
 *
 * One control: the `worktrees` switch. It renders into the Plugins page's
 * `plugins.row.config` slot, keyed `<package name>#<row id>`. Values and writes
 * come from the Host through the `form` prop; this file renders one control and
 * decides nothing.
 *
 * Deliberately one control and one write. The previous version of this page
 * offered every setting and saved them all, which rewrote the profile's
 * hand-maintained patch file with keys nobody had asked for. This one writes
 * only `worktrees`, so a save cannot leave anything behind.
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

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '560px' },
      heading: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      lede: { margin: 0, fontSize: '13px', lineHeight: '20px', opacity: 0.8 },
      label: { fontSize: '14px', lineHeight: '22px', fontWeight: 500 },
      switchRow: { display: 'flex', alignItems: 'center', gap: '10px' },
      note: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.65 },
      error: { margin: 0, fontSize: '12px', lineHeight: '18px' },
      alert: { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 500 },
      summary: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
      detail: { display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '17px' },
      detailItem: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.7 },
    };

    /** The effective value: the decoded value, then the user layer, then the patch layer. */
    function valueOf(state) {
      const layers = [state?.value, state?.user, state?.base];
      for (const layer of layers) {
        const candidate = layer === undefined || layer === null ? undefined : layer.worktrees;
        if (candidate !== undefined && candidate !== null) return candidate === true;
      }
      return false;
    }

    /**
     * The row's Configure page.
     *
     * `view: 'summary'` is the one-liner the Plugins list shows; `view: 'page'` is
     * the page itself.
     */
    function ConfigPage(props) {
      const { view, form } = props;
      const state = form?.state;
      const [error, setError] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const writable = state?.writable !== false;
      const worktrees = valueOf(state);

      if (view === 'summary') {
        if (form === undefined) return React.createElement('span', { style: styles.summary }, 'git · settings unavailable');
        return React.createElement('span', { style: styles.summary }, 'git · worktrees: ' + (worktrees ? 'on' : 'off'));
      }

      if (form === undefined) {
        return React.createElement(
          'div',
          { style: styles.wrap },
          React.createElement('p', { style: styles.alert, role: 'alert' }, 'This page has no settings to show.'),
          React.createElement('p', { style: styles.note },
            'The Host did not serve this row\'s settings namespace. The plugin still works with '
              + 'every setting at its default. Editing the row in cordis.patch.yml changes the same setting.'),
        );
      }

      const write = (value) => {
        if (typeof form.mutate !== 'function') return;
        setSaving(true);
        setError(null);
        Promise.resolve(form.mutate([{ op: 'set', path: ['worktrees'], value }], state?.revision))
          .then((ok) => { if (ok === false) setError('The Host did not accept that change.'); })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .then(() => setSaving(false));
      };

      return React.createElement(
        'div',
        { style: styles.wrap },
        writable ? null : React.createElement('p', { style: styles.note }, 'Read-only here: this row is pinned by a layer above this window.'),
        error === null ? null : React.createElement('p', { style: styles.error, role: 'alert' }, error),
        React.createElement(
          'label',
          { style: styles.switchRow },
          React.createElement('input', {
            type: 'checkbox',
            role: 'switch',
            'aria-checked': worktrees === true,
            checked: worktrees === true,
            disabled: !writable || saving,
            onChange: (event) => write(event.target.checked),
          }),
          React.createElement('span', { style: styles.label }, 'Worktree mode'),
        ),
        React.createElement('p', { style: styles.note },
          'On: an edit to a repository on a protected branch is refused and points at action "start", '
            + 'so work lands in a worktree on a task branch. Off: regular mode — edit anywhere, no worktree required.'),
      );
    }

    /**
     * Mount the row's Configure page.
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
    exports.ConfigPage = ConfigPage;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
