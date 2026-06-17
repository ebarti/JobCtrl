import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addressSelectionFromGooglePlace,
  GoogleAddressSearchField,
  resetGoogleAddressSearchForTest,
} from "./GoogleAddressSearchField.js";

describe("<GoogleAddressSearchField>", () => {
  afterEach(() => {
    delete (window as { google?: unknown }).google;
    document.getElementById("jobhunter-google-maps-places")?.remove();
    resetGoogleAddressSearchForTest();
  });

  it("renders a normal street-address field when Google Maps is not configured", () => {
    render(
      <GoogleAddressSearchField
        apiKey=""
        value="Joan Maragall 17"
        onAddressChange={vi.fn()}
        onAddressSelect={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Address")).toHaveAttribute("autocomplete", "street-address");
    expect(screen.getByLabelText("Address")).toHaveAttribute("type", "search");
    expect(screen.getByText("manual")).toBeInTheDocument();
  });

  it("maps a selected Google address into the profile address fields", () => {
    expect(
      addressSelectionFromGooglePlace(
        {
          addressComponents: [
            { longText: "17", shortText: "17", types: ["street_number"] },
            { longText: "Carrer de Joan Maragall", shortText: "Carrer de Joan Maragall", types: ["route"] },
            { longText: "Cabrera de Mar", shortText: "Cabrera de Mar", types: ["locality"] },
            { longText: "Barcelona", shortText: "Barcelona", types: ["administrative_area_level_1"] },
            { longText: "Spain", shortText: "ES", types: ["country"] },
            { longText: "08349", shortText: "08349", types: ["postal_code"] },
          ],
        },
        "Joan Maragall 17",
      ),
    ).toEqual({
      address: "17 Carrer de Joan Maragall",
      city: "Cabrera de Mar",
      country: "Spain",
      postalCode: "08349",
      provinceState: "Barcelona",
    });
  });

  it("uses the Google Places widget to validate and select an address", async () => {
    const onAddressSelect = vi.fn();
    const place = {
      addressComponents: [
        { longText: "17", shortText: "17", types: ["street_number"] },
        { longText: "Carrer de Joan Maragall", shortText: "Carrer de Joan Maragall", types: ["route"] },
        { longText: "Cabrera de Mar", shortText: "Cabrera de Mar", types: ["locality"] },
        { longText: "Barcelona", shortText: "Barcelona", types: ["administrative_area_level_1"] },
        { longText: "Spain", shortText: "ES", types: ["country"] },
        { longText: "08349", shortText: "08349", types: ["postal_code"] },
      ],
      fetchFields: vi.fn(async () => undefined),
    };
    const createPlaceAutocompleteElement = vi.fn(function createPlaceAutocompleteElement(options: { value?: string }) {
      const element = document.createElement("gmp-place-autocomplete") as HTMLElement & {
        value?: string;
      };
      if (options.value !== undefined) {
        element.value = options.value;
      }
      return element;
    });
    (window as unknown as { google: unknown }).google = {
      maps: {
        importLibrary: vi.fn(async () => ({
          PlaceAutocompleteElement: createPlaceAutocompleteElement,
        })),
      },
    };

    render(
      <GoogleAddressSearchField
        apiKey="maps-test-key"
        value="Joan Maragall 17"
        onAddressChange={vi.fn()}
        onAddressSelect={onAddressSelect}
      />,
    );

    expect(await screen.findByText("search ready")).toBeInTheDocument();
    expect(createPlaceAutocompleteElement).toHaveBeenCalledWith(
      expect.objectContaining({
        includedPrimaryTypes: ["street_address"],
        value: "Joan Maragall 17",
      }),
    );
    const widget = document.querySelector("gmp-place-autocomplete") as HTMLElement & {
      value?: string;
    };
    expect(widget).toHaveAttribute("id", "profile-address-search");

    await act(async () => {
      const event = new Event("gmp-select") as Event & {
        placePrediction: { toPlace: () => typeof place };
      };
      event.placePrediction = { toPlace: () => place };
      widget.dispatchEvent(event);
    });

    await waitFor(() => expect(place.fetchFields).toHaveBeenCalledWith({ fields: ["addressComponents"] }));
    expect(onAddressSelect).toHaveBeenCalledWith({
      address: "17 Carrer de Joan Maragall",
      city: "Cabrera de Mar",
      country: "Spain",
      postalCode: "08349",
      provinceState: "Barcelona",
    });
    expect(screen.getByText("validated")).toBeInTheDocument();
  });
});
