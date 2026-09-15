# Upstream provenance

The host connection implementation is derived from
`deepseek-ai/deepseek-harness`, package
`@deepseek-ai/dsh-client-connection`, originally at commit
`47f943859bef60e4160492346772ded9b24f765a`, and is maintained since as a minimal
authorization patch against the wire contract of whichever line `package.json`
declares.

The browser bundle is generated at build time from the official
`@deepseek-ai/dsh-client-connection` artifact resolved by that same declared
dependency range, with only its module registration id changed to this package
name. No upstream version is restated here: the declared range is the single
source of truth, so this notice cannot drift out of date.
