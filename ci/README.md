# perimetry-cloud-ci

Perimetry Cloud in your CI: run an audit of a proved domain after a deployment (or read the latest one), wait for it, and fail the job when the score falls below a minimum, drops since the previous audit, or a new critical finding appears. No dependency: Node.js 20 or later.

Not published yet (the npm name is to be decided; examples will then pin the version, `@x.y.z`). From the sources:

```
PERIMETRY_API_KEY=pc_… node ci/bin/perimetry-ci.mjs check --domain example.com --min-score 80
```

The key is read from `PERIMETRY_API_KEY` only (never from an argument), sent in the `Authorization` header only, and never printed. `perimetry-ci --help` lists the options: `--mode run|latest`, `--timeout`, `--min-score`, `--fail-on-drop`, `--max-drop`, `--fail-on-new`, `--fail-on-open`, `--on-too-soon`, `--json`, `--summary`, `--lang`, `--api-url`.

Exit codes: 0 passed, 1 the gate failed, 2 configuration or API error, 3 the audit did not finish in time. With `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` set (GitHub Actions), it writes the job summary and the outputs `passed`, `score`, `grade`, `previous-score`, `score-delta`, `new-findings`, `report-url`, `result-file`.

Documentation: https://perimetry.cloud/help/ci-github-action/

---

**En français.** Perimetry Cloud dans votre intégration continue : lance un audit d’un domaine prouvé après un déploiement (ou lit le dernier), l’attend, et fait échouer la tâche quand la note passe sous un minimum, baisse depuis l’audit précédent, ou qu’un nouveau constat critique apparaît. La clé est lue dans `PERIMETRY_API_KEY` seulement et n’est jamais affichée. Documentation : https://perimetry.cloud/fr/aide/integration-continue-github-action/

## Development

`npm test` runs the tests against a stand-in of the API (`test/fake-api.mjs`, also used by the MCP server's tests), and the composite action (`../action.yml`) as GitHub runs it. The package is `private` until its publication is decided.
