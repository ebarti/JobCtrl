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

interface GooglePlacePrediction {
  toPlace(): GooglePlaceDetails;
}

interface GooglePlacePredictionSelectEvent extends Event {
  placePrediction?: GooglePlacePrediction;
}

interface GooglePlaceAutocompleteElement extends HTMLElement {
  description?: string;
  includedPrimaryTypes?: string[];
  placeholder?: string;
  value?: string;
}

interface GoogleMapsPlacesLibrary {
  PlaceAutocompleteElement: new (options: {
    description?: string;
    includedPrimaryTypes?: string[];
    name?: string;
    placeholder?: string;
    value?: string;
  }) => GooglePlaceAutocompleteElement;
}

interface GoogleMapsApi {
  maps: {
    importLibrary?: (libraryName: string, ...args: unknown[]) => Promise<unknown>;
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
let googleMapsPlacesPromise: Promise<GoogleMapsPlacesLibrary> | null = null;

export function GoogleAddressSearchField({
  apiKey,
  value,
  onAddressChange,
  onAddressSelect,
}: GoogleAddressSearchFieldProps) {
  const widgetHostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<GooglePlaceAutocompleteElement | null>(null);
  const onAddressChangeRef = useRef(onAddressChange);
  const onAddressSelectRef = useRef(onAddressSelect);
  const statusRef = useRef<"idle" | "loading" | "ready" | "validating" | "validated" | "error">("idle");
  const valueRef = useRef(value);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "validating" | "validated" | "error">(
    "idle",
  );
  const trimmedKey = apiKey.trim();

  useEffect(() => {
    onAddressChangeRef.current = onAddressChange;
  }, [onAddressChange]);

  useEffect(() => {
    onAddressSelectRef.current = onAddressSelect;
  }, [onAddressSelect]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    valueRef.current = value;
    const widget = widgetRef.current;
    if (widget && widget.value !== value) {
      widget.value = value;
    }
  }, [value]);

  useEffect(() => {
    if (!trimmedKey) {
      setStatus("idle");
      return;
    }
    const host = widgetHostRef.current;
    if (!host) {
      return;
    }
    let disposed = false;
    let widget: GooglePlaceAutocompleteElement | null = null;
    let selectListener: ((event: Event) => void) | null = null;
    let inputListener: (() => void) | null = null;
    let errorListener: (() => void) | null = null;

    setStatus("loading");
    void loadGoogleMapsPlaces(trimmedKey)
      .then((placesLibrary) => {
        if (disposed) {
          return;
        }

        widget = new placesLibrary.PlaceAutocompleteElement({
          description: "Search Google Maps for an address.",
          includedPrimaryTypes: ["street_address"],
          name: "profile-address-search-google",
          placeholder: "Search address",
          value: valueRef.current,
        });
        widget.id = ADDRESS_INPUT_ID;
        widget.classList.add("google-address-widget");
        widget.setAttribute("aria-describedby", ADDRESS_STATUS_ID);
        widget.value = valueRef.current;
        widgetRef.current = widget;

        selectListener = (event: Event) => {
          const currentWidget = widget;
          if (currentWidget) {
            void handleGoogleAddressSelection(event as GooglePlacePredictionSelectEvent, currentWidget);
          }
        };
        inputListener = () => {
          onAddressChangeRef.current(widget?.value ?? "");
          if (statusRef.current === "validated") {
            setStatus("ready");
          }
        };
        errorListener = () => setStatus("error");

        widget.addEventListener("gmp-select", selectListener);
        widget.addEventListener("input", inputListener);
        widget.addEventListener("gmp-error", errorListener);
        host.replaceChildren(widget);
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) {
          setStatus("error");
        }
      });

    async function handleGoogleAddressSelection(
      event: GooglePlacePredictionSelectEvent,
      autocompleteWidget: GooglePlaceAutocompleteElement,
    ) {
      const placePrediction = event.placePrediction;
      if (!placePrediction) {
        setStatus("error");
        return;
      }

      setStatus("validating");
      try {
        const place = placePrediction.toPlace();
        await place.fetchFields?.({ fields: ["addressComponents"] });
        if (!disposed) {
          const selection = addressSelectionFromGooglePlace(place, autocompleteWidget.value ?? valueRef.current);
          if (!selection) {
            setStatus("error");
            return;
          }
          onAddressSelectRef.current(selection);
          setStatus("validated");
        }
      } catch {
        if (!disposed) {
          setStatus("error");
        }
      }
    }

    return () => {
      disposed = true;
      if (widget && selectListener) {
        widget.removeEventListener("gmp-select", selectListener);
      }
      if (widget && inputListener) {
        widget.removeEventListener("input", inputListener);
      }
      if (widget && errorListener) {
        widget.removeEventListener("gmp-error", errorListener);
      }
      if (widgetRef.current === widget) {
        widgetRef.current = null;
      }
      host.replaceChildren();
    };
  }, [trimmedKey]);

  const statusText = addressStatusText(status, Boolean(trimmedKey));
  const showGoogleWidget = Boolean(trimmedKey) && (status === "ready" || status === "validating" || status === "validated");

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
      <div className="google-address-widget-host" hidden={!showGoogleWidget} ref={widgetHostRef} />
      {!showGoogleWidget ? (
        <input
          autoComplete="street-address"
          aria-describedby={ADDRESS_STATUS_ID}
          id={ADDRESS_INPUT_ID}
          type="search"
          value={value}
          onChange={(event) => {
            onAddressChange(event.target.value);
            if (status === "validated") {
              setStatus(trimmedKey ? "ready" : "idle");
            }
          }}
        />
      ) : null}
    </div>
  );
}

export function addressSelectionFromGooglePlace(
  place: GooglePlaceDetails,
  typedAddress: string,
): GoogleAddressSelection | null {
  const components = place.addressComponents ?? place.address_components ?? [];
  if (!components.length && !place.formattedAddress && !place.formatted_address) {
    return null;
  }

  const streetNumber = componentLongName(components, "street_number");
  const route = componentLongName(components, "route");
  const streetAddress = componentLongName(components, "street_address");
  const formattedAddress = (place.formattedAddress ?? place.formatted_address)?.split(",").at(0)?.trim() ?? "";
  const address = [streetNumber, route].filter(Boolean).join(" ") || streetAddress || formattedAddress || typedAddress;
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
    postalCode: [componentLongName(components, "postal_code"), componentLongName(components, "postal_code_suffix")]
      .filter(Boolean)
      .join("-"),
    provinceState: isUnitedStatesCountry(country, countryCode)
      ? componentLongName(components, "administrative_area_level_1")
      : "",
  };
}

function componentLongName(components: GoogleAddressComponent[], type: string): string {
  const component = components.find((candidate) => candidate.types.includes(type));
  return component?.longText ?? component?.long_name ?? "";
}

function componentShortName(components: GoogleAddressComponent[], type: string): string {
  const component = components.find((candidate) => candidate.types.includes(type));
  return component?.shortText ?? component?.short_name ?? "";
}

function isUnitedStatesCountry(country: string, countryCode: string): boolean {
  const normalizedCountryCode = countryCode.trim().toUpperCase();
  if (normalizedCountryCode === "US" || normalizedCountryCode === "USA") {
    return true;
  }
  const normalizedCountry = country.trim().toLowerCase();
  return normalizedCountry === "united states" || normalizedCountry === "united states of america";
}

function addressStatusText(
  status: "idle" | "loading" | "ready" | "validating" | "validated" | "error",
  configured: boolean,
): string {
  if (!configured) {
    return "manual";
  }
  switch (status) {
    case "loading":
      return "loading";
    case "ready":
      return "search ready";
    case "validating":
      return "validating";
    case "validated":
      return "validated";
    case "error":
      return "maps unavailable";
    case "idle":
      return "manual";
  }
}

function loadGoogleMapsPlaces(apiKey: string): Promise<GoogleMapsPlacesLibrary> {
  const googleWindow = getGoogleMapsWindow();
  if (googleWindow.google?.maps.importLibrary) {
    return googleWindow.google.maps.importLibrary("places") as Promise<GoogleMapsPlacesLibrary>;
  }
  if (googleMapsPlacesPromise) {
    return googleMapsPlacesPromise;
  }

  const google = installGoogleMapsImportLibrary(apiKey);
  googleMapsPlacesPromise = google.maps.importLibrary?.("places") as Promise<GoogleMapsPlacesLibrary>;
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

      const existingScript = document.getElementById(GOOGLE_MAPS_SCRIPT_ID) as HTMLScriptElement | null;
      if (existingScript) {
        existingScript.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), { once: true });
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
      script.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), { once: true });
      document.head.appendChild(script);
    });

    return scriptLoadPromise.then(() => {
      if (maps.importLibrary === bootstrapImportLibrary) {
        throw new Error("Google Maps importLibrary did not initialize.");
      }
      return maps.importLibrary?.(libraryName, ...args) ?? Promise.reject(new Error("Google Maps importLibrary missing."));
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
