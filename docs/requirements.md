# Requirements

This file records product requirements that must remain true as implementation
details change.

## Discovery Location Filtering

- Target-search location inputs must be validated as real places before they
  are saved.
- For hybrid or on-site target work models, discovery filters exclusively for
  the target location, for example `Barcelona, Spain`.
- For remote target work models, discovery filters for the target country, for
  example `Spain`.
- For remote target work models in European countries, discovery must also
  include jobs that are remote in Europe.
- Profile-driven target discovery must search at least the last 30 days unless
  the local search configuration explicitly sets a larger lookback window.
