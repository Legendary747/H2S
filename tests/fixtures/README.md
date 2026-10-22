# Offline HTML fixtures

These files are small, authored test pages for the userscript's DOM contract. They are not archived website pages or a housing dataset. Residence titles and URL slugs are fictional (`Example residence` / `example-*`), and extra-charge text is synthetic. Do not use their values as current rental information or open their example listing URLs.

The fixtures retain the selectors, short interface labels, city names, filter IDs, numeric rent values, counts and status combinations needed to reproduce earlier parser regressions. In particular, the tests keep unsorted prices, separate service charges, direct-booking versus lottery states, nested sort controls, selected-filter chips, and incomplete pagination.

| Files | Contract exercised |
| --- | --- |
| `residences.html`, `snapshot-global.html` | Ten visible rows out of 109 results, 11 pages, mixed cities and unsorted main rents |
| `the-hague-listings.html`, `snapshot-the-hague.html` | Nine single-city rows, including lottery entries and three direct-booking entries within a €1,500 test budget |
| `the-hague-filters.html` | Matching selected-city chip and checkbox; clear-all control excluded from filter data |
| `availability-filters.html` | Availability labels distinguished from city labels |
| `sort-menu.html`, `sort-menu-date.html` | Nested buttons and labels, active sort markers, and different trigger titles |

The `snapshot-*` filenames remain for compatibility with the historical browser test runner; their present contents are synthetic. This revision removes the former copied page structure, real residence addresses, marketing text, images, styles and other unrelated material. It does not rewrite older Git commits, which may contain the earlier fixtures.

The website's name, interface labels and selector identifiers are used solely to describe interoperability. No affiliation, endorsement or permission to automate the website is implied.
