import { IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

export interface GoogleAddressSelection {
  address: string;
  city: string;
  country: string;
  postalCode: string;
  provinceState: string;
}

export interface GoogleAddressSearchFieldProps {
  apiKey: string;
  value: string;
  onAddressChange: (value: string) => void;
  onAddressSelect: (selection: GoogleAddressSelection) => void;
}

interface GoogleAddressComponent {
  longText?: string;
  long_name?: string;
  shortText?: string;
  short_name?: string;
  types: string[];
}

interface GooglePlaceDetails {
  addressComponents?: GoogleAddressComponent[];
  address_components?: GoogleAddressComponent[];
  formattedAddress?: string;
  formatted_address?: string;
  fetchFields?: (request: { fields: string[] }) => Promise<void>;
}

interface GoogleFormattableText {
  text?: string;
  toString?: () => string;
}

interface GooglePlacePrediction {
  placeId?: string;
  text?: GoogleFormattableText | string;
  mainText?: GoogleFormattableText | string;
  secondaryText?: GoogleFormattableText | string;
  toPlace(): GooglePlaceDetails;
}

interface GoogleAutocompleteSuggestion {
  placePrediction?: GooglePlacePrediction;
}

interface GoogleAutocompleteRequest {
  input: string;
  includedPrimaryTypes?: string[];
  sessionToken?: unknown;
}

interface GoogleMapsPlacesLibrary {
  AutocompleteSessionToken: new () => unknown;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions: (
      request: GoogleAutocompleteRequest,
    ) => Promise<{
      suggestions: GoogleAutocompleteSuggestion[];
    }>;
  };
}

interface GoogleMapsApi {
  maps: {
    importLibrary?: (
      libraryName: string,
      ...args: unknown[]
    ) => Promise<unknown>;
    [callbackName: string]: unknown;
  };
}

type GoogleMapsWindow = Window &
  typeof globalThis & {
    google?: GoogleMapsApi;
    __jobhunterGoogleMapsReady?: () => void;
  };

const GOOGLE_MAPS_SCRIPT_ID = "jobhunter-google-maps-places";
const GOOGLE_MAPS_CALLBACK = "__jobhunterGoogleMapsReady";
const ADDRESS_INPUT_ID = "profile-address-search";
const ADDRESS_STATUS_ID = "profile-address-validation-status";
const ADDRESS_RESULTS_ID = "profile-address-search-results";
let googleMapsPlacesPromise: Promise<GoogleMapsPlacesLibrary> | null = null;

type AddressSearchStatus =
  | "idle"
  | "loading"
  | "ready"
  | "searching"
  | "validating"
  | "validated"
  | "no-results"
  | "error";

interface AddressPredictionOption {
  id: string;
  label: string;
  placePrediction: GooglePlacePrediction;
}

export function GoogleAddressSearchField({
  apiKey,
  value,
  onAddressChange,
  onAddressSelect,
}: GoogleAddressSearchFieldProps) {
  const onAddressChangeRef = useRef(onAddressChange);
  const onAddressSelectRef = useRef(onAddressSelect);
  const valueRef = useRef(value);
  const placesLibraryRef = useRef<GoogleMapsPlacesLibrary | null>(null);
  const [status, setStatus] = useState<AddressSearchStatus>("idle");
  const [predictions, setPredictions] = useState<AddressPredictionOption[]>([]);
  const trimmedKey = apiKey.trim();
  const canSearch =
    Boolean(trimmedKey) &&
    Boolean(value.trim()) &&
    !["loading", "searching", "validating"].includes(status);

  useEffect(() => {
    onAddressChangeRef.current = onAddressChange;
  }, [onAddressChange]);

  useEffect(() => {
    onAddressSelectRef.current = onAddressSelect;
  }, [onAddressSelect]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!trimmedKey) {
      setStatus("idle");
      placesLibraryRef.current = null;
      setPredictions([]);
      return;
    }
    let disposed = false;

    setStatus("loading");
    void loadGoogleMapsPlaces(trimmedKey)
      .then((placesLibrary) => {
        if (disposed) {
          return;
        }
        placesLibraryRef.current = placesLibrary;
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) {
          placesLibraryRef.current = null;
          setStatus("error");
        }
      });

    return () => {
      disposed = true;
    };
  }, [trimmedKey]);

  const searchGoogleAddress = async () => {
    const query = valueRef.current.trim();
    const placesLibrary = placesLibraryRef.current;
    if (!trimmedKey || !query || !placesLibrary) {
      return;
    }
    setStatus("searching");
    setPredictions([]);
    try {
      const sessionToken = new placesLibrary.AutocompleteSessionToken();
      const response =
        await placesLibrary.AutocompleteSuggestion.fetchAutocompleteSuggestions(
          {
            input: query,
            includedPrimaryTypes: ["street_address"],
            sessionToken,
          },
        );
      const nextPredictions = response.suggestions
        .map((suggestion, index) => {
          const placePrediction = suggestion.placePrediction;
          if (!placePrediction) {
            return null;
          }
          const label = placePredictionLabel(placePrediction);
          if (!label) {
            return null;
          }
          return {
            id: placePrediction.placeId || `${label}-${index}`,
            label,
            placePrediction,
          };
        })
        .filter((option): option is AddressPredictionOption => option !== null);
      setPredictions(nextPredictions);
      setStatus(nextPredictions.length ? "ready" : "no-results");
    } catch {
      setStatus("error");
    }
  };

  const validatePrediction = async (prediction: AddressPredictionOption) => {
    setStatus("validating");
    try {
      const place = prediction.placePrediction.toPlace();
      await place.fetchFields?.({
        fields: ["addressComponents", "formattedAddress"],
      });
      const selection = addressSelectionFromGooglePlace(
        place,
        valueRef.current,
      );
      if (!selection) {
        setStatus("error");
        return;
      }
      setPredictions([]);
      onAddressSelectRef.current(selection);
      setStatus("validated");
    } catch {
      setStatus("error");
    }
  };

  const statusText = addressStatusText(status, Boolean(trimmedKey));
  const showSearchButton = Boolean(trimmedKey);
  const searchButtonLabel = status === "searching" ? "Searching" : "Search";

  return (
    <div className="field google-address-field">
      <div className="google-address-label-row">
        <label htmlFor={ADDRESS_INPUT_ID}>Address</label>
        <span
          className={`field-hint address-validation-status ${status}`}
          id={ADDRESS_STATUS_ID}
          role={status === "error" ? "alert" : "status"}
        >
          {statusText}
        </span>
      </div>
      <div className="google-address-control">
        <input
          autoComplete="street-address"
          aria-controls={predictions.length ? ADDRESS_RESULTS_ID : undefined}
          aria-describedby={ADDRESS_STATUS_ID}
          aria-expanded={predictions.length ? true : undefined}
          aria-autocomplete={showSearchButton ? "list" : undefined}
          id={ADDRESS_INPUT_ID}
          type="search"
          value={value}
          onKeyDown={(event) => {
            if (event.key === "Enter" && showSearchButton) {
              event.preventDefault();
              void searchGoogleAddress();
            }
          }}
          onChange={(event) => {
            onAddressChange(event.target.value);
            setPredictions([]);
            if (status === "validated") {
              setStatus(trimmedKey ? "ready" : "idle");
            } else if (status === "no-results" || status === "error") {
              setStatus(trimmedKey ? "ready" : "idle");
            }
          }}
        />
        {showSearchButton ? (
          <button
            aria-label="Search address"
            className="google-address-search-button"
            disabled={!canSearch}
            type="button"
            onClick={() => void searchGoogleAddress()}
          >
            <IconSearch size={14} aria-hidden="true" />
            <span>{searchButtonLabel}</span>
          </button>
        ) : null}
      </div>
      {predictions.length ? (
        <ul
          aria-label="Address search results"
          className="google-address-results"
          id={ADDRESS_RESULTS_ID}
          role="listbox"
        >
          {predictions.map((prediction) => (
            <li key={prediction.id} role="presentation">
              <button
                className="google-address-result"
                disabled={status === "validating"}
                role="option"
                type="button"
                onClick={() => void validatePrediction(prediction)}
              >
                {prediction.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function addressSelectionFromGooglePlace(
  place: GooglePlaceDetails,
  typedAddress: string,
): GoogleAddressSelection | null {
  const components = place.addressComponents ?? place.address_components ?? [];
  if (
    !components.length &&
    !place.formattedAddress &&
    !place.formatted_address
  ) {
    return null;
  }

  const streetNumber = componentLongName(components, "street_number");
  const route = componentLongName(components, "route");
  const streetAddress = componentLongName(components, "street_address");
  const formattedAddress =
    (place.formattedAddress ?? place.formatted_address)
      ?.split(",")
      .at(0)
      ?.trim() ?? "";
  const address =
    [streetNumber, route].filter(Boolean).join(" ") ||
    streetAddress ||
    formattedAddress ||
    typedAddress;
  const country = componentLongName(components, "country");
  const countryCode = componentShortName(components, "country");

  return {
    address,
    city:
      componentLongName(components, "locality") ||
      componentLongName(components, "postal_town") ||
      componentLongName(components, "sublocality_level_1") ||
      componentLongName(components, "administrative_area_level_2"),
    country,
    postalCode: [
      componentLongName(components, "postal_code"),
      componentLongName(components, "postal_code_suffix"),
    ]
      .filter(Boolean)
      .join("-"),
    provinceState: isUnitedStatesAddressCountry(country, countryCode)
      ? componentLongName(components, "administrative_area_level_1")
      : "",
  };
}

function componentLongName(
  components: GoogleAddressComponent[],
  type: string,
): string {
  const component = components.find((candidate) =>
    candidate.types.includes(type),
  );
  return component?.longText ?? component?.long_name ?? "";
}

function componentShortName(
  components: GoogleAddressComponent[],
  type: string,
): string {
  const component = components.find((candidate) =>
    candidate.types.includes(type),
  );
  return component?.shortText ?? component?.short_name ?? "";
}

function placePredictionLabel(prediction: GooglePlacePrediction): string {
  return (
    formattableTextValue(prediction.text) ||
    [
      formattableTextValue(prediction.mainText),
      formattableTextValue(prediction.secondaryText),
    ]
      .filter(Boolean)
      .join(", ")
      .trim()
  );
}

function formattableTextValue(
  value: GoogleFormattableText | string | undefined,
): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return value.text ?? value.toString?.() ?? "";
}

export function isUnitedStatesAddressCountry(
  country: string,
  countryCode = "",
): boolean {
  const normalizedCountryCode = countryCode.trim().toUpperCase();
  if (normalizedCountryCode === "US" || normalizedCountryCode === "USA") {
    return true;
  }
  const normalizedCountry = country.trim().toLowerCase();
  return (
    normalizedCountry === "united states" ||
    normalizedCountry === "united states of america"
  );
}

function addressStatusText(
  status: AddressSearchStatus,
  configured: boolean,
): string {
  if (!configured) {
    return "manual";
  }
  switch (status) {
    case "loading":
      return "loading";
    case "searching":
      return "searching";
    case "ready":
      return "search ready";
    case "validating":
      return "validating";
    case "validated":
      return "validated";
    case "no-results":
      return "no results";
    case "error":
      return "maps unavailable";
    case "idle":
      return "manual";
  }
}

function loadGoogleMapsPlaces(
  apiKey: string,
): Promise<GoogleMapsPlacesLibrary> {
  const googleWindow = getGoogleMapsWindow();
  if (googleWindow.google?.maps.importLibrary) {
    return googleWindow.google.maps.importLibrary(
      "places",
    ) as Promise<GoogleMapsPlacesLibrary>;
  }
  if (googleMapsPlacesPromise) {
    return googleMapsPlacesPromise;
  }

  const google = installGoogleMapsImportLibrary(apiKey);
  googleMapsPlacesPromise = google.maps.importLibrary?.(
    "places",
  ) as Promise<GoogleMapsPlacesLibrary>;
  return googleMapsPlacesPromise;
}

function installGoogleMapsImportLibrary(apiKey: string): GoogleMapsApi {
  const googleWindow = getGoogleMapsWindow();
  const google = (googleWindow.google ??= { maps: {} });
  const maps = (google.maps ??= {});
  if (maps.importLibrary) {
    return google;
  }

  const requestedLibraries = new Set<string>();
  let scriptLoadPromise: Promise<void> | null = null;
  const bootstrapImportLibrary = (libraryName: string, ...args: unknown[]) => {
    requestedLibraries.add(libraryName);
    scriptLoadPromise ??= new Promise<void>((resolve, reject) => {
      maps[GOOGLE_MAPS_CALLBACK] = resolve;

      const existingScript = document.getElementById(
        GOOGLE_MAPS_SCRIPT_ID,
      ) as HTMLScriptElement | null;
      if (existingScript) {
        existingScript.addEventListener(
          "error",
          () => reject(new Error("Google Maps failed to load.")),
          { once: true },
        );
        return;
      }

      const script = document.createElement("script");
      const params = new URLSearchParams({
        callback: `google.maps.${GOOGLE_MAPS_CALLBACK}`,
        key: apiKey,
        libraries: [...requestedLibraries].join(","),
        loading: "async",
        v: "weekly",
      });
      script.id = GOOGLE_MAPS_SCRIPT_ID;
      script.async = true;
      script.defer = true;
      script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
      script.addEventListener(
        "error",
        () => reject(new Error("Google Maps failed to load.")),
        { once: true },
      );
      document.head.appendChild(script);
    });

    return scriptLoadPromise.then(() => {
      if (maps.importLibrary === bootstrapImportLibrary) {
        throw new Error("Google Maps importLibrary did not initialize.");
      }
      return (
        maps.importLibrary?.(libraryName, ...args) ??
        Promise.reject(new Error("Google Maps importLibrary missing."))
      );
    });
  };

  maps.importLibrary = bootstrapImportLibrary;
  return google;
}

function getGoogleMapsWindow(): GoogleMapsWindow {
  return window as GoogleMapsWindow;
}

export function resetGoogleAddressSearchForTest() {
  googleMapsPlacesPromise = null;
}
