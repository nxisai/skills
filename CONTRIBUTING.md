# Contributing

This repository is public so you can read the skills, audit what they tell your agent to do in
your project and on your site, and install them yourself. Thank you for being here.

## What helps right now

Issues. Genuinely — they are the most useful thing you can send us today:

- **A skill that misfires.** It started when it should not have, did not start when it should,
  or handed off to the wrong skill.
- **An agent that went wrong following a skill.** Which skill, which agent host and model, what
  was asked, and what it did.
- **Steps that no longer match.** A command, flag or tool name a skill uses that the `nxis` CLI
  or the MCP server no longer has, or that behaves differently from what the skill expects.
- **A host profile that fails.** A hosting guide whose steps do not work on that host, or a draft
  profile you have run end to end.
- **Unclear errors.** If a skill left you with a message that said something went wrong but not
  what to do about it, that is a bug in our writing and we want to hear it.
- **Documentation that is wrong.** Including this file.

A good bug report beats a patch we cannot merge yet.

## What we are not accepting yet

**Pull requests.** Not because we do not want the help, but because the skills are changing
quickly alongside the platform they drive, and we would be wasting your time.

The skills follow the CLI commands, the MCP tools and the hosted agents they set up, and those
are still moving. When one of them changes, the skills that use it are rewritten with it, often
across several skills at once. An edit written against any given week can be invalidated by the
next one, through no fault of yours. Asking people to write changes against that would be
discourteous.

When the platform settles, this changes. See [Later](#later).

## If you open a pull request anyway

It will be closed, with thanks and a link back here. Nothing more than that — no judgment, and
it does not count against you.

If the underlying fix is right, we will make it and credit you by name in the commit that does.
So the most effective thing to do is open an issue describing the problem and, if you like, what
you think the fix is. That gets your name on the change without either of us pretending the PR
could be merged.

## Later

**We do not have a date yet.** We would rather say that than invent one.

What has to be true before pull requests open:

- The CLI commands and MCP tools the skills call have held still for a full release cycle.
- A change to a skill can be checked without an NxisAI account.
- A maintainer can commit to a stated review turnaround.

When those hold we will update this file, remove the automation that closes pull requests, and
label some real issues as good first ones.

## Sign-off

When contributions do open, this project uses the
[Developer Certificate of Origin](https://developercertificate.org/). It is a short statement
that you wrote the patch, or otherwise have the right to submit it under this project's license.

You certify it by signing off your commits:

```bash
git commit -s -m "fix: whatever you fixed"
```

which appends a line like `Signed-off-by: Your Name <you@example.com>`. You keep your copyright;
your contribution is licensed under Apache-2.0 like the rest of the repository. There is no
separate agreement to sign.

## Security

**Do not open a public issue for a security problem.**

See [SECURITY.md](SECURITY.md) for how to report one privately. We would much rather hear about
it from you first than read about it at the same time as everyone else.

## License

By participating you agree that your contributions are licensed under
[Apache-2.0](LICENSE), the same license as this repository.
