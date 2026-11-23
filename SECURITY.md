# Security

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting instead:
[**Report a vulnerability**](https://github.com/nxisai/skills/security/advisories/new).
It opens a private thread visible only to you and the maintainers, and it works without you
needing an email address of ours or a PGP key.

Useful things to include, as far as you have them:

- What an attacker could do, not only what the skill says.
- The skill, the commit you installed it from, and the agent host and model that ran it.
- Steps to reproduce, or a proof of concept.
- Whether you have told anyone else.

If you cannot use GitHub's reporting for any reason, open an issue saying only that you have a
security report and would like a private channel — **no details** — and we will open one.

## What to expect

| | |
|---|---|
| We acknowledge | within 3 business days |
| We give an initial assessment | within 10 business days |
| We tell you our fix timeline | with that assessment |

If a report affects users, we will publish an advisory and credit you unless you would rather we
did not. If we disagree that something is a vulnerability, we will say so and explain why, rather
than letting the thread go quiet.

We ask for reasonable time to fix an issue before it is made public. We will not ask you to stay
quiet indefinitely, and we will not threaten anyone for reporting in good faith.

## Supported versions

The skills are not versioned yet and change quickly. Only the latest commit on `main` is
supported; a fix goes out as a new commit there, and reinstalling the skills picks it up.

## Scope

This repository holds the skills: the instructions an agent follows, and the reference code
under each skill's `references/` that an agent writes into your project.

**In scope:** anything in this repository. A skill that can lead an agent to expose a secret,
take an action without the consent it says it asks for, or send data somewhere it says it does
not; reference code that is unsafe once deployed, such as a model proxy or a host profile; a
skill that page content or tool output can steer into doing something else; and the checks that
run on this repository.

**Out of scope here, but still wanted:** flaws in the NxisAI services the skills talk to, and in
the `nxis` CLI and the agent harness, which have their own repositories. Report those the same
way and we will route them internally — the service code is not public, so this is the right
door to knock on.

## Things worth knowing before you report

Two behaviors look alarming and are intentional:

- **The site token in a page is not a secret.** The NxisAI site tag the skills install carries a
  token in its script tag, and every visitor can read it. It identifies the site, works only on
  the domains it lists, and grants nothing private. The provisioning key used during onboarding
  is a secret, and the skills never write it into the project.
- **Model keys stay on the site's server.** Where an agent on a page uses a remote model, the
  skills write an endpoint on the site's own server that holds the key. A page with a vendor key
  in it is a misconfiguration of that page, not something a skill asked for.

If you have found something that contradicts either of those, we would very much like to know.
