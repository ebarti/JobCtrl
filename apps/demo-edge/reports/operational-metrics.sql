-- Non-linkable operational populations only. No event, identity, retry-digest,
-- or rate-budget table is referenced by this report.
SELECT
  'all choices' AS population,
  release,
  'consent_choice' AS metric,
  consent_choice AS dimension_1,
  '' AS dimension_2,
  SUM(count) AS observations
FROM daily_operational_counters
WHERE metric = 'consent_choice'
  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
GROUP BY release, consent_choice

UNION ALL

SELECT
  'granted initialization attempts' AS population,
  release,
  'initialization_result' AS metric,
  consent_choice AS dimension_1,
  storage_mode || ':' || initialization_result AS dimension_2,
  SUM(count) AS observations
FROM daily_operational_counters
WHERE metric = 'initialization_result'
  AND consent_choice = 'granted'
  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
GROUP BY release, consent_choice, storage_mode, initialization_result
ORDER BY population, release, dimension_1, dimension_2;
