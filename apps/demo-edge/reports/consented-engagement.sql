WITH current_events AS (
  SELECT * FROM consented_product_events
  WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
), metrics AS (
  SELECT release, 'tour' AS metric, event_name AS dimension_1,
         COALESCE(tour_step, '') AS dimension_2, COUNT(*) AS events,
         COUNT(DISTINCT visitor_hash) AS unique_visitors,
         COUNT(DISTINCT session_hash) AS unique_sessions
  FROM current_events
  WHERE event_name IN ('demo_tour_started', 'demo_tour_step_completed', 'demo_tour_completed')
  GROUP BY release, event_name, tour_step
  UNION ALL
  SELECT release, 'action', event_name,
         COALESCE(feature_name, '') || ':' || COALESCE(action_name, '') || ':' || COALESCE(result_code, ''),
         COUNT(*), COUNT(DISTINCT visitor_hash), COUNT(DISTINCT session_hash)
  FROM current_events
  WHERE event_name IN ('demo_action_started', 'demo_action_completed', 'demo_action_failed', 'demo_action_cancelled')
  GROUP BY release, event_name, feature_name, action_name, result_code
  UNION ALL
  SELECT release, 'workspace_reset', '', '', COUNT(*),
         COUNT(DISTINCT visitor_hash), COUNT(DISTINCT session_hash)
  FROM current_events WHERE event_name = 'demo_workspace_reset' GROUP BY release
  UNION ALL
  SELECT release, 'client_error', COALESCE(error_code, ''), '', COUNT(*),
         COUNT(DISTINCT visitor_hash), COUNT(DISTINCT session_hash)
  FROM current_events WHERE event_name = 'demo_client_error'
  GROUP BY release, error_code
)
SELECT 'consented traffic' AS population, * FROM metrics
ORDER BY release, metric, dimension_1, dimension_2;
