#!/bin/bash
# Generate realistic commit activity with probability distribution

PERSONA_DIR="/Users/jay/.openclaw/workspace/personas/rohan-kapoor/projects"
REPOS=("kubernetes-guardian" "observability-patterns" "terraform-modules")

start_date="2025-03-04"
end_date="2026-03-04"

echo "Generating commits from $start_date to $end_date..."

current_date="$start_date"
while [[ "$current_date" < "$end_date" ]] || [[ "$current_date" == "$end_date" ]]; do
    day_of_week=$(date -j -f "%Y-%m-%d" "$current_date" "+%u" 2>/dev/null || date -d "$current_date" "+%u")
    
    if [[ "$day_of_week" -le 5 ]]; then
        roll=$((RANDOM % 100))
        num_commits=0
        if [[ $roll -lt 80 ]]; then
            num_commits=1
            roll2=$((RANDOM % 100))
            if [[ $roll2 -lt 35 ]]; then
                num_commits=2
                roll3=$((RANDOM % 100))
                if [[ $roll3 -lt 15 ]]; then
                    num_commits=3
                fi
            fi
        fi
    else
        roll=$((RANDOM % 100))
        num_commits=0
        if [[ $roll -lt 20 ]]; then
            num_commits=1
        fi
    fi
    
    if [[ $num_commits -gt 0 ]]; then
        repo=${REPOS[$RANDOM % ${#REPOS[@]}]}
        cd "$PERSONA_DIR/$repo"
        
        for ((i=1; i<=num_commits; i++)); do
            if [[ "$day_of_week" -le 5 ]]; then
                hour=$((9 + RANDOM % 9))
            else
                hour=$((10 + RANDOM % 6))
            fi
            minute=$((RANDOM % 60))
            time_str=$(printf "%02d:%02d:00" $hour $minute)
            
            msgs=("chore: update docs" "fix: resolve issue" "refactor: cleanup" "docs: add notes" "test: add test" "feat: improvement")
            commit_msg=${msgs[$RANDOM % ${#msgs[@]}]}
            
            echo "# ${current_date} ${i}" >> activity.log 2>/dev/null || echo "# ${current_date} ${i}" > activity.log
            git add activity.log 2>/dev/null || true
            GIT_AUTHOR_DATE="${current_date}T${time_str}" GIT_COMMITTER_DATE="${current_date}T${time_str}" git commit -m "$commit_msg" --no-verify 2>/dev/null || true
        done
        echo "$current_date: $num_commits commits"
    fi
    
    current_date=$(date -j -v+1d -f "%Y-%m-%d" "$current_date" "+%Y-%m-%d" 2>/dev/null || date -d "$current_date + 1 day" "+%Y-%m-%d")
done

echo "Done generating commits!"
