# 0007. Published under a scope, because npm refuses the bare name

- **Date:** 2026-10-03
- **Status:** accepted

## Context

The product is called detent: the catch that holds a mechanism in a defined
position until it is deliberately released. Here it is released by a green
gauge. The name carries the thesis, so it was chosen before publication and
checked against the registry first.

The check said the name was free. The registry returns `404` for
`https://registry.npmjs.org/detent`, and `npm publish --dry-run` reported no
problem, because a dry run never contacts the registry's name policy.

The real publish did:

```
npm error 403 Forbidden - PUT https://registry.npmjs.org/detent
npm error 403 Package name too similar to existing packages dedent, dotenv, redent
```

## Decision

Publish as **`@kazimvakhobov/detent`**, with `publishConfig.access: "public"`.

The repository stays `kazimVahobov/detent`, the product is called detent in
every text, and the command remains `detent`.

## Consequences

- The install line carries the scope; nothing else does. `bin` is independent of
  the package name, so `npm i -g @kazimvakhobov/detent` still gives you a
  `detent` command.
- `publishConfig.access` means the first publish of a scoped package does not
  need `--access=public` remembered on the command line, now or in CI.
- **A `404` from the registry means unregistered, not publishable.** Name policy
  — typosquatting distance, in this case — is enforced only on a real `PUT`.
  Any future rename gets verified by an actual publish attempt, not by a lookup.

## Alternatives rejected

**Rename the product.** A shortlist was checked against both the registry and
recognisability on GitHub. Almost every single English word on npm is held by a
dead squat — registered years ago, zero downloads — which blocks the name
without giving it any meaning. detent survived that search for a reason worth
keeping: the word *is* the explanation of what the tool does.

**Appeal the similarity filter.** There is a support path, measured in weeks,
with no reason to expect a different answer. The scope costs one prefix in one
line of documentation.
