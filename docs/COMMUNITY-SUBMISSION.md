# Community submission preparation

Status: preparation only; not submitted or listed. Checked 2026-10-19.

Repository: https://github.com/minLaoGe/obsidian-pdf-plus-sync
Current shipped version: 0.45.3 (GitHub prerelease, installed under legacy ID `pdf-plus`).

## Current official route

- https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin
- https://docs.obsidian.md/community-directory/set-up-and-claim
- https://docs.obsidian.md/community-directory/developer-policies
- https://docs.obsidian.md/community-directory/submission-requirements-for-plugins

Submit through https://community.obsidian.md using an Obsidian account linked to the GitHub repository owner. The manifest at the default branch HEAD is used; its version must have matching release assets. Do not open an obsolete community-plugins.json pull request as a substitute.

## Fork eligibility: pending

The code derives substantially from RyotaUshio/obsidian-pdf-plus 0.40.31. MIT permission to reuse code is distinct from the directory's eligibility rules.

Verified upstream latest default-branch commit:
https://github.com/RyotaUshio/obsidian-pdf-plus/commit/6a3218b9c506076b405438489e614bc9e22b833b
Date: 2025-08-30. This exceeds six months as of the check date; the repository is not archived. This date alone does not prove the author is unreachable or authorize immediate submission.

The user explicitly authorized posting the prepared request. Public contact was submitted by minLaoGe on 2026-10-19 at 11:34:02 UTC: https://github.com/RyotaUshio/obsidian-pdf-plus/issues/592 . The issue is open; permission has not yet been granted. The 30-day interval ends 2026-11-18 at 11:34:02 UTC. This date is an eligibility checkpoint, not automatic approval: recheck the response and current official policy before submission. The posted body is retained in UPSTREAM-PERMISSION-REQUEST.md.

## Release changes to complete after eligibility is established

- Use the unique ID `pdf-plus-sync`, after checking directory availability. The shipped `pdf-plus` ID belongs to the upstream community entry and cannot be submitted as a new entry.
- Review ID-dependent settings, local storage, protocol handlers, internal plugin lookups, and any hard-coded installation paths. Preserve attribution and explain disabling the upstream plugin; the two patch the same PDF viewer and must not run together.
- Supply explicit migration instructions from the legacy folder. Back up and copy existing data.json rather than deleting it. Preserve vault-level PDF++ Sync data and PDF annotations.
- Correct compatibility declarations: current `minAppVersion: 1.5.8` is not supported by the evidence collected so far. Development used macOS Obsidian 1.14.4. Optional upstream child_process features must remain desktop-gated; review before declaring mobile support. User has requested no interactive self-tests, so do not claim mobile or full runtime validation.
- Prepare a normal release with the exact manifest version as tag and main.js, manifest.json, styles.css attachments. All releases so far are prereleases; there is no latest normal release returned by GitHub's latest-release API.
- Preserve LICENSE, original author credit, and Interact.js MIT notice in the bundle/package. Document optional network features and external file/process access inherited from upstream.
- Sign into the community directory, link the correct GitHub owner, and prepare the entry. The user must handle any account creation, credential changes, or legally binding consent required by the website.
- Submit only with accurate ownership, fork eligibility, compatibility, and maintenance declarations. Record scanner feedback and address concrete issues without claiming review approval prematurely.

## Submission text draft

Name: PDF++ Sync
Proposed ID: pdf-plus-sync
Repository: https://github.com/minLaoGe/obsidian-pdf-plus-sync
Description: Edit PDF text annotations and colored highlights, organize bookmarks, and resume reading across devices through vault synchronization.
Attribution: Independently maintained by minLaoGe, based on PDF++ 0.40.31 by Ryota Ushio and its contributors; not the upstream official version.

## User-side information needed

1. A public approval response, or a policy-eligible conclusion after the documented contact/wait process. Contact authorization is complete.
2. Obsidian community account access and GitHub connection when the submission is eligible.

No code, installed settings, plugin ID, or normal-release status was changed as part of this preparation.
