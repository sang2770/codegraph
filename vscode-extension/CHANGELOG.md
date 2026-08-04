# Changelog

All notable changes to the CodeBrain VS Code extension are documented here.

## [0.3.3] - 2026-08-03

### Added

- Added project README context to `/explain` and `/review` so explanations and reviews can use documented terminology, intended behavior, and contracts.
- Added clearer impact analysis results with severity scoring, explainable signals, test coverage status, evidence confidence, and recommendations.
- Improved the workflow graph and Markdown impact report to show changed files, dependent workflows, and affected tests more clearly.

### Changed

- README content is now the user-facing installation and usage guide shown in the VS Code extension Details page.
- Development instructions remain available in `DEVELOPMENT.md` for contributors and are excluded from the packaged VSIX.

## [0.3.2]

### Added

- Added the user-facing CodeBrain workflow guide and extension feature documentation.
- Added interactive impact analysis, affected-test detection, workflow graph visualization, and local token-saving metrics.
