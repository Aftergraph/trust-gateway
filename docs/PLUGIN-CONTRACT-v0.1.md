# Plugin Contract v0.1

**Superseded by [Plugin Contract v0.2](./PLUGIN-CONTRACT-v0.2.md).**

v0.1 introduced the declarative fields for permissions, tools, views, events,
automations and `sandbox: "jailed"`. Its separate `58-plugins.js` HTTP mount
was later found to overlap the older W4 `35-plugins.js` surface; because the
gateway dispatches the first filename-sorted mount match, that implementation
was shadowed.

v0.2 preserves explicit v0.1 manifests as compatibility input while converging
runtime ownership, validation and tests on the canonical W4 hub.
