#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# The matrix of the Implementer's accident guard (#761): about forty git actions an agent may run, in a
# throwaway repository with the `reference-transaction` hook of runner/guard/ installed the way the Worker
# installs it (core.hooksPath in a GIT_CONFIG_SYSTEM file, the guard configuration in a file). The image
# smoke test runs it as the engine user inside the image, and the Worker runs it as that user before every
# turn: a failure is `setup_failed`, never a turn without a guard.
#
# Allowed actions must succeed (and, when they move the branch, signal through the spool); blocked ones
# must fail with the branch and HEAD unchanged. The ways around the hook that no hook can close
# (`-c core.hooksPath=/dev/null`, a hand-written ref file) are not in the matrix: the push check of the
# runner covers them.
#
# Usage: guard_matrix.sh [--list]
#   --list   print "<allow|block> <action>" per action and exit
# Environment: GUARD_DIR (default /opt/code-reviewer/guard) holds the hook, TMPDIR the throwaway directory.
# Exit status: 0 every action behaved, 1 an action did not, 2 the matrix cannot run (git older than
# 2.53, which does not show a branch switch to the hook, or no hook file).
set -u

GUARD_DIR=${GUARD_DIR:-/opt/code-reviewer/guard}
MIN_GIT=2.53.0

# kind|effect|name|function. An allowed action's effect is signal (the branch moves and the spool gets a line),
# quiet (neither) or keep (the branch stays; git may still report a same-tip update, e.g. `stash` resets the
# branch to itself, and a spool hint costs the runner one verified push attempt). A blocked action's effect
# is head (HEAD stays on the branch) or free (the action itself leaves HEAD detached before it is tried).
ACTIONS=(
  "allow|signal|commit|a_commit"
  "allow|signal|commit -a --no-verify|a_commit_no_verify"
  "allow|signal|commit --allow-empty|a_commit_empty"
  "allow|signal|revert HEAD|a_revert"
  "allow|signal|merge --ff-only of a new commit|a_ff_merge"
  "allow|signal|cherry-pick of a new commit|a_cherry_pick"
  "allow|keep|stash and stash pop|a_stash"
  "allow|quiet|fetch (updates refs/remotes)|a_fetch"
  "allow|quiet|restore a file|a_restore"
  "allow|quiet|gc|a_gc"
  "allow|quiet|gc --auto|a_gc_auto"
  "allow|quiet|pack-refs --all --prune|a_pack_refs"
  "allow|quiet|maintenance run|a_maintenance"
  "allow|quiet|git init of a fixture repository|a_init"
  "allow|quiet|clone of a repository with a tag|a_clone_tag"
  "allow|quiet|init, fetch and checkout FETCH_HEAD in another repository|a_fetch_checkout"
  "allow|quiet|a nested repository: init, commit, branch, tag|a_nested_repo"
  "block|head|commit --amend|b_amend"
  "block|head|reset --soft HEAD~1|b_reset_soft"
  "block|head|reset --hard HEAD~1|b_reset_hard"
  "block|head|reset --hard to the start commit|b_reset_start"
  "block|head|reset --hard origin/main|b_reset_main"
  "block|head|rebase -f onto the start commit|b_rebase_force"
  "block|head|rebase -i squash|b_rebase_squash"
  "block|head|rebase --onto origin/main|b_rebase_onto"
  "block|head|branch other|b_branch"
  "block|head|checkout -b other|b_checkout_b"
  "block|head|switch -c other|b_switch_c"
  "block|head|checkout main|b_checkout_main"
  "block|head|switch main|b_switch_main"
  "block|head|checkout origin/main (detached)|b_checkout_origin"
  "block|head|checkout --detach|b_checkout_detach"
  "block|head|checkout the start commit (detached)|b_checkout_start"
  "block|head|tag v1|b_tag"
  "block|head|update-ref of another branch|b_update_ref_other"
  "block|head|update-ref of the branch back to the start|b_update_ref_back"
  "block|free|branch -D of the branch|b_branch_delete"
  "block|free|branch -D of the branch after pack-refs|b_branch_delete_packed"
  "block|head|update-ref -d of the branch|b_update_ref_delete"
  "block|head|branch -m (rename)|b_branch_rename"
  "block|head|worktree add|b_worktree_add"
)

if [ "${1:-}" = "--list" ]; then
  for spec in "${ACTIONS[@]}"; do
    IFS='|' read -r kind _ name _ <<<"$spec"
    echo "$kind $name"
  done
  exit 0
fi

refuse() {
  echo "guard_matrix: $*" >&2
  exit 2
}

version=$(git --version 2>/dev/null | sed -n 's/^git version \([0-9][0-9.]*\).*/\1/p')
[ -n "$version" ] || refuse "git is not available"
[ "$(printf '%s\n%s\n' "$MIN_GIT" "$version" | sort -V | head -n 1)" = "$MIN_GIT" ] ||
  refuse "git $version is older than $MIN_GIT: a branch switch is invisible to the hook on that git, so the guard cannot be proven"
[ -x "$GUARD_DIR/reference-transaction" ] || refuse "no executable hook at $GUARD_DIR/reference-transaction"

work=$(mktemp -d) || refuse "cannot make a temporary directory"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home"
export HOME="$work/home" GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=Matrix GIT_AUTHOR_EMAIL=matrix@example.invalid
export GIT_COMMITTER_NAME=Matrix GIT_COMMITTER_EMAIL=matrix@example.invalid
export CODE_REVIEWER_GUARD_CONF="$work/guard.conf"
spool="$work/spool"
printf '[core]\n\thooksPath = %s\n[safe]\n\tdirectory = *\n' "$GUARD_DIR" >"$work/system.gitconfig"

# Plain git for the set-up and the resets between actions: no hook, no system config.
raw() { GIT_CONFIG_SYSTEM=/dev/null git "$@"; }
# What the agent runs: the hook is active, as the Worker configures it.
export GIT_CONFIG_SYSTEM="$work/system.gitconfig"

origin="$work/origin.git"
repo="$work/repo"
raw init -q --bare -b main "$origin" || refuse "git init failed"
raw clone -q "$origin" "$work/seed" 2>/dev/null || refuse "git clone failed"
(
  cd "$work/seed" || exit 1
  echo a >a.txt
  raw add -A
  raw commit -qm base
  raw tag v0
  raw push -q origin HEAD:main v0
) || refuse "cannot seed the repository"
raw clone -q -b main "$origin" "$repo" || refuse "git clone failed"
cd "$repo" || refuse "cannot enter the repository"
raw checkout -qb work
start=$(raw rev-parse HEAD)
echo x >f1
raw add f1
raw commit -qm c1
echo y >>f1
raw commit -qam c2
tip=$(raw rev-parse HEAD)
# main moves on after the branch was started, so origin/main is not the start commit.
(
  cd "$work/seed" || exit 1
  echo b >b.txt
  raw add -A
  raw commit -qm "main moves on"
  raw push -q origin HEAD:main
) || refuse "cannot move main"
raw fetch -q origin
printf 'BRANCH=work\nSTART=%s\nSPOOL=%s\nREPO=%s\n' "$start" "$spool" "$repo" >"$CODE_REVIEWER_GUARD_CONF"

reset_state() {
  raw rebase --abort 2>/dev/null
  raw cherry-pick --abort 2>/dev/null
  raw merge --abort 2>/dev/null
  rm -rf "$work/wt" "$work/fixture" "$work/clone-tag" "$work/fetched" "$repo/nested"
  raw worktree prune
  raw checkout -qf work 2>/dev/null
  raw update-ref refs/heads/work "$tip"
  raw reset -q --hard "$tip"
  raw clean -qfd
  local ref
  for ref in $(raw for-each-ref --format='%(refname:short)' refs/heads | grep -v -e '^work$' -e '^main$'); do
    raw branch -qD "$ref"
  done
  for ref in $(raw tag); do raw tag -d "$ref" >/dev/null; done
  raw stash clear
  rm -f .git/refs/heads/x
}

# Commits on a side branch made without the guard (the set-up of the merge and cherry-pick actions).
side_commit() { # <branch> <file>
  raw branch -q "$1" && raw checkout -q "$1" && echo m >"$2" && raw add "$2" && raw commit -qm "$2" && raw checkout -q work
}

a_commit() { echo n >f3 && git add f3 && git commit -qm n1; }
a_commit_no_verify() { echo n >>f1 && git commit -qam n2 --no-verify; }
a_commit_empty() { git commit -q --allow-empty -m e; }
a_revert() { git revert --no-edit HEAD; }
a_ff_merge() { side_commit s2 m2 && git merge --ff-only s2; }
a_cherry_pick() { side_commit s3 m3 && git cherry-pick "$(raw rev-parse s3)"; }
a_stash() { echo z >>f1 && git stash -q && git stash pop -q; }
a_fetch() { git fetch -q origin; }
a_restore() { echo z >>f1 && git restore f1; }
a_gc() { git gc -q; }
# Two packs and a pack limit of one make `gc --auto` do its work, which git does by itself after a few commands.
a_gc_auto() {
  raw repack -qad && side_commit s9 m9 && raw repack -qd &&
    git -c gc.autoPackLimit=1 -c gc.autoDetach=false gc --auto
}
a_pack_refs() { git pack-refs --all --prune; }
a_maintenance() { git maintenance run; }
# What a build or a test does in the job: other repositories, with the hook active through the system config.
a_init() { git init -q -b main "$work/fixture" && git -C "$work/fixture" commit -q --allow-empty -m fixture; }
a_clone_tag() { git clone -q "$origin" "$work/clone-tag" && git -C "$work/clone-tag" rev-parse -q --verify refs/tags/v0 >/dev/null; }
a_fetch_checkout() {
  git init -q -b main "$work/fetched" && git -C "$work/fetched" fetch -q "$origin" main &&
    git -C "$work/fetched" checkout -q FETCH_HEAD
}
a_nested_repo() {
  git init -q -b main nested && git -C nested commit -q --allow-empty -m n && git -C nested branch side &&
    git -C nested tag t1 && git -C nested checkout -q side && git -C nested gc -q
}
b_amend() { git commit --amend -qm amended; }
b_reset_soft() { git reset -q --soft HEAD~1; }
b_reset_hard() { git reset -q --hard HEAD~1; }
b_reset_start() { git reset -q --hard "$start"; }
b_reset_main() { git reset -q --hard origin/main; }
b_rebase_force() { git rebase -q -f "$start"; }
b_rebase_squash() { GIT_SEQUENCE_EDITOR="sed -i '2s/^pick/squash/'" GIT_EDITOR=true git rebase -q -i "$start"; }
b_rebase_onto() { git rebase -q --onto origin/main "$start"; }
b_branch() { git branch other; }
b_checkout_b() { git checkout -q -b other; }
b_switch_c() { git switch -q -c other; }
b_checkout_main() { git checkout -q main; }
b_switch_main() { git switch -q main; }
b_checkout_origin() { git checkout -q origin/main; }
b_checkout_detach() { git checkout -q --detach; }
b_checkout_start() { git checkout -q "$start"; }
b_tag() { git tag v1; }
b_update_ref_other() { git update-ref refs/heads/x HEAD; }
b_update_ref_back() { git update-ref refs/heads/work "$start"; }
b_branch_delete() { raw checkout -q --detach && git branch -D work; }
b_branch_delete_packed() { raw pack-refs --all --prune && raw checkout -q --detach && git branch -D work; }
b_update_ref_delete() { git update-ref -d refs/heads/work; }
b_branch_rename() { git branch -m work renamed; }
b_worktree_add() { git worktree add -q -b wt "$work/wt"; }

passed=0
failed=0
for spec in "${ACTIONS[@]}"; do
  IFS='|' read -r kind effect name fn <<<"$spec"
  reset_state
  : >"$spool"
  tip0=$(raw rev-parse -q --verify refs/heads/work)
  out=$("$fn" 2>&1)
  rc=$?
  tip1=$(raw rev-parse -q --verify refs/heads/work)
  head1=$(raw symbolic-ref -q HEAD)
  signals=$(wc -l <"$spool" | tr -d ' ')
  problem=""
  if [ "$kind" = allow ]; then
    [ "$rc" -eq 0 ] || problem="exit status $rc"
    # `git gc` and `maintenance` end with status 0 when a part of them ("failed to run pack-refs") was refused.
    case "$out" in *code-reviewer-guard:*) problem="${problem:+$problem, }the guard refused a part of it" ;; esac
    case "$effect" in
      signal)
        { [ "$tip1" != "$tip0" ] && [ "$signals" -ge 1 ]; } || problem="${problem:+$problem, }the branch did not move or the spool got no line"
        ;;
      keep)
        [ "$tip1" = "$tip0" ] || problem="${problem:+$problem, }the branch moved"
        ;;
      *)
        { [ "$tip1" = "$tip0" ] && [ "$signals" -eq 0 ]; } || problem="${problem:+$problem, }the branch moved or the spool got a line"
        ;;
    esac
  else
    [ "$rc" -ne 0 ] || problem="it succeeded"
    [ "$tip1" = "$tip0" ] || problem="${problem:+$problem, }the branch moved"
    if [ "$effect" = head ] && [ "$head1" != "refs/heads/work" ]; then
      problem="${problem:+$problem, }HEAD left the branch"
    fi
  fi
  if [ -z "$problem" ]; then
    passed=$((passed + 1))
    printf 'ok    %-5s %s\n' "$kind" "$name"
  else
    failed=$((failed + 1))
    printf 'FAIL  %-5s %s: %s\n' "$kind" "$name" "$problem"
    printf '%s\n' "$out" | head -n 3 | sed 's/^/        /'
  fi
done

echo "guard matrix: $passed passed, $failed failed (git $version)"
[ "$failed" -eq 0 ]
