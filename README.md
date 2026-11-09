# Perimetry Cloud audit gate

A GitHub Action that runs (or reads) a [Perimetry Cloud](https://perimetry.cloud) audit of a proved domain after a deployment, and fails the job when the score falls below a minimum, drops since the previous audit, or a new critical finding appears. A summary goes to the job page; the full result to `$RUNNER_TEMP/perimetry-result.json`.

```yaml
- name: Perimetry Cloud
  uses: Enigmacker/perimetry-cloud-action@v1
  with:
    api-key: ${{ secrets.PERIMETRY_API_KEY }}
    domain: example.com
    min-score: 80
```

For the strongest guarantee, pin the action to a full commit SHA instead of `@v1`.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api-key` | required | A Perimetry Cloud API key, from a secret (Settings › API keys). Read-only is enough with `mode: latest`; `mode: run` needs a key that can start audits. |
| `domain` | required | The proved domain (`example.com`) or its id. |
| `mode` | `run` | `run` starts an audit and waits for it; `latest` reads the latest audit. |
| `timeout-minutes` | `15` | How long to wait for the audit. |
| `min-score` | | Fail below this score (0–100). |
| `fail-on-drop` | `true` | Fail when the score drops since the previous audit. |
| `max-drop` | `0` | Points the score may drop before failing. |
| `fail-on-new` | `critical` | Fail on a new finding of this severity or above (`none` to disable). |
| `fail-on-open` | `none` | Fail while open findings of this severity or above remain. |
| `on-too-soon` | `latest` | When an audit ran too recently: read the latest one, or `fail`. |
| `lang` | `en` | Language of the summary (`en` or `fr`). |
| `api-url` | | Only for testing against another instance. |

Outputs: `passed`, `score`, `grade`, `previous-score`, `score-delta`, `new-findings`, `report-url`, `result-file`.

## Security

- The inputs reach the command through the environment only, never inside the script; the key only as `PERIMETRY_API_KEY`, sent in the `Authorization` header and never printed.
- The action runs only the command shipped next to it in `ci/`. It never downloads a package at run time.
- Text coming from audited sites is escaped in the job summary, and links in it are not clickable.
- Report a vulnerability: security@perimetry.cloud.

Documentation: https://perimetry.cloud/help/ci-github-action/

---

**En français.** Cette action lance (ou lit) un audit Perimetry Cloud d'un domaine prouvé après un déploiement, et fait échouer la tâche quand la note passe sous un minimum, baisse depuis l'audit précédent, ou qu'un nouveau constat critique apparaît. La clé est lue dans un secret et n'est jamais affichée. Documentation : https://perimetry.cloud/fr/aide/integration-continue-github-action/
