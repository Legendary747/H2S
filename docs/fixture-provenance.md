# Fixture provenance

Current HTML fixtures in `tests/fixtures/` are minimal, project-authored synthetic markup with invented example listing names and URLs. They preserve only the selectors, control labels, statuses, city/filter values, and numeric conditions needed to exercise parser and regression behavior. They contain no website images or application scripts and are not a real property feed or evidence of current availability. See the [fixture notes](../tests/fixtures/README.md).

Earlier commits contained reduced extracts from user-supplied Holland2Stay page snapshots. Replacing the current files does not remove those historical Git objects or old PR diffs. A repository-wide public-release review must include that history and any other retained copies.

The project's MIT license covers project-authored code and documentation. It does not assert ownership of, or relicense, third-party website content, trademarks, or assets. Identifying the origin of historical material is not a grant of permission to redistribute it.

For new tests, use minimal synthetic markup and invented listing data. Do not add full page captures, images, embedded application scripts, account information, cookies, authentication data, or personal search history. Where a regression requires an observed interface structure, reduce it to the necessary selectors and behavior and document its origin.
