# The By-owner view nests by ownership first, and forks inside it

The sidebar's "By owner" view builds one tree from two parent relations with a precedence, rather than ownership alone or one merged tree with two edge styles:

1. **Ownership wins.** A session whose shipmates owner (`ownerSessionPath`) is listed nests under that owner, and its fork parent is ignored for placement, except in rule 4.
2. **Unlisted owner means a root.** A session whose owner is set but not listed is a root marked "(not listed)", and its fork parent is ignored too.
3. **Otherwise the fork parent.** A session with no owner nests under its fork parent (`parentSessionPath`) when that parent is listed, at whatever depth the parent sits.
4. **Forks among siblings.** Among siblings with the same direct owner, a fork of another sibling becomes that sibling's child. This applies only when that owner is listed: roots that share an unlisted owner stay roots.

The tree is built over the full listing, closed sessions included, and closed visibility is applied only afterwards. That way, hiding a closed parent never turns its children into roots.

## Considered Options

- **Ownership only.** Rejected: users who fork by hand would lose the fork structure the folder view gives them, and a hand-made fork of a worker would fall out of its orchestration.
- **One merged tree with two edge styles.** Rejected: one session could have two different parents, so the tree no longer has one meaning.
