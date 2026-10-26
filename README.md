# 急救研習室 · First Aid Study Lab

**Current website: [yu17-first-aid.pages.dev](https://yu17-first-aid.pages.dev/)**

The app, account login and progress database now run on Cloudflare. It does not connect to GPT Sites and does not require ChatGPT sign-in or a connection window.

Reference text, all 471 exercises, 30-question quizzes, source scans and results require a study account. Account creation requires the instructor's designated code, enforced on the server. Account records are kept in Cloudflare D1; password verification uses a private Durable Object with strong salted hashing.

This public repository contains only the old-address redirect. Book data, server bundles, scans, credentials and learner records are not published here. Backend source remains in the private development workspace.
