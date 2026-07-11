WITH current_events AS (
  SELECT * FROM consented_product_events
  WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
), metrics AS (
  SELECT release, 'unique_audience' AS metric, '' AS dimension_1, '' AS dimension_2,
         COUNT(*) AS events, COUNT(DISTINCT visitor_hash) AS unique_visitors,
         COUNT(DISTINCT session_hash) AS unique_sessions
  FROM current_events GROUP BY release
  UNION ALL
  SELECT release, 'route_reach', route_name, '', COUNT(*),
         COUNT(DISTINCT visitor_hash), COUNT(DISTINCT session_hash)
  FROM current_events WHERE event_name = 'demo_route_viewed' AND route_name IS NOT NULL
  GROUP BY release, route_name
  UNION ALL
  SELECT release, 'feature_reach', feature_name, '', COUNT(*),
         COUNT(DISTINCT visitor_hash), COUNT(DISTINCT session_hash)
  FROM current_events WHERE event_name = 'demo_feature_opened' AND feature_name IS NOT NULL
  GROUP BY release, feature_name
)
SELECT 'consented traffic' AS population, * FROM metrics
ORDER BY release, metric, dimension_1, dimension_2;
