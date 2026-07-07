import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addressSelectionFromGooglePlace,
  GoogleAddressSearchField,
  resetGoogleAddressSearchForTest,
} from "./GoogleAddressSearchField.js";

describe("<GoogleAddressSearchField>", () => {
  afterEach(() => {
    delete (window as { google?: unknown }).google;
    document.getElementById("jobctrl-google-maps-places")?.remove();
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

    expect(screen.getByLabelText("Address")).toHaveAttribute(
      "autocomplete",
      "street-address",
    );
    expect(screen.getByLabelText("Address")).toHaveAttribute("type", "search");
    expect(screen.getByText("manual")).toBeInTheDocument();
  });

  it("maps a selected non-US Google address without province/state", () => {
    expect(
      addressSelectionFromGooglePlace(
        {
          addressComponents: [
            { longText: "17", shortText: "17", types: ["street_number"] },
            {
              longText: "Carrer de Joan Maragall",
              shortText: "Carrer de Joan Maragall",
              types: ["route"],
            },
            {
              longText: "Cabrera de Mar",
              shortText: "Cabrera de Mar",
              types: ["locality"],
            },
            {
              longText: "Barcelona",
              shortText: "Barcelona",
              types: ["administrative_area_level_1"],
            },
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
      provinceState: "",
    });
  });

  it("maps a selected US Google address with state", () => {
    expect(
      addressSelectionFromGooglePlace(
        {
          addressComponents: [
            { longText: "1600", shortText: "1600", types: ["street_number"] },
            {
              longText: "Pennsylvania Avenue Northwest",
              shortText: "Pennsylvania Ave NW",
              types: ["route"],
            },
            {
              longText: "Washington",
              shortText: "Washington",
              types: ["locality"],
            },
            {
              longText: "District of Columbia",
              shortText: "DC",
              types: ["administrative_area_level_1"],
            },
            { longText: "United States", shortText: "US", types: ["country"] },
            { longText: "20500", shortText: "20500", types: ["postal_code"] },
          ],
        },
        "1600 Pennsylvania Ave NW",
      ),
    ).toEqual({
      address: "1600 Pennsylvania Avenue Northwest",
      city: "Washington",
      country: "United States",
      postalCode: "20500",
      provinceState: "District of Columbia",
    });
  });

  it("searches Google Places explicitly and validates a selected address", async () => {
    const onAddressSelect = vi.fn();
    const place = {
      addressComponents: [
        { longText: "17", shortText: "17", types: ["street_number"] },
        {
          longText: "Carrer de Joan Maragall",
          shortText: "Carrer de Joan Maragall",
          types: ["route"],
        },
        {
          longText: "Cabrera de Mar",
          shortText: "Cabrera de Mar",
          types: ["locality"],
        },
        {
          longText: "Barcelona",
          shortText: "Barcelona",
          types: ["administrative_area_level_1"],
        },
        { longText: "Spain", shortText: "ES", types: ["country"] },
        { longText: "08349", shortText: "08349", types: ["postal_code"] },
      ],
      fetchFields: vi.fn(async () => undefined),
    };
    const fetchAutocompleteSuggestions = vi.fn(async () => ({
      suggestions: [
        {
          placePrediction: {
            placeId: "cabrera-address",
            text: { text: "17 Carrer de Joan Maragall, Cabrera de Mar, Spain" },
            toPlace: () => place,
          },
        },
      ],
    }));
    const AutocompleteSessionToken = vi.fn(function AutocompleteSessionToken() {
      return {};
    });
    (window as unknown as { google: unknown }).google = {
      maps: {
        importLibrary: vi.fn(async () => ({
          AutocompleteSessionToken,
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions,
          },
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
    const searchButton = screen.getByRole("button", { name: "Search address" });
    fireEvent.click(searchButton);

    await waitFor(() =>
      expect(fetchAutocompleteSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({
          includedPrimaryTypes: ["street_address"],
          input: "Joan Maragall 17",
        }),
      ),
    );
    expect(AutocompleteSessionToken).toHaveBeenCalledTimes(1);
    const result = await screen.findByRole("option", {
      name: "17 Carrer de Joan Maragall, Cabrera de Mar, Spain",
    });

    await act(async () => {
      fireEvent.click(result);
    });

    await waitFor(() =>
      expect(place.fetchFields).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: ["addressComponents", "formattedAddress"],
        }),
      ),
    );
    expect(onAddressSelect).toHaveBeenCalledWith({
      address: "17 Carrer de Joan Maragall",
      city: "Cabrera de Mar",
      country: "Spain",
      postalCode: "08349",
      provinceState: "",
    });
    expect(screen.getByText("validated")).toBeInTheDocument();
  });

  it("shows an explicit empty state when Google returns no address results", async () => {
    const fetchAutocompleteSuggestions = vi.fn(async () => ({
      suggestions: [],
    }));
    (window as unknown as { google: unknown }).google = {
      maps: {
        importLibrary: vi.fn(async () => ({
          AutocompleteSessionToken: vi.fn(function AutocompleteSessionToken() {
            return {};
          }),
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions,
          },
        })),
      },
    };

    render(
      <GoogleAddressSearchField
        apiKey="maps-test-key"
        value="Not a real address"
        onAddressChange={vi.fn()}
        onAddressSelect={vi.fn()}
      />,
    );

    expect(await screen.findByText("search ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search address" }));

    await waitFor(() =>
      expect(fetchAutocompleteSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({
          input: "Not a real address",
        }),
      ),
    );
    expect(screen.getByText("no results")).toBeInTheDocument();
    expect(
      screen.queryByRole("listbox", { name: "Address search results" }),
    ).not.toBeInTheDocument();
  });

  it("keeps manual address editing in sync when Google Maps is configured", async () => {
    const onAddressChange = vi.fn();
    (window as unknown as { google: unknown }).google = {
      maps: {
        importLibrary: vi.fn(async () => ({
          AutocompleteSessionToken: vi.fn(function AutocompleteSessionToken() {
            return {};
          }),
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: vi.fn(async () => ({
              suggestions: [],
            })),
          },
        })),
      },
    };

    render(
      <GoogleAddressSearchField
        apiKey="maps-test-key"
        value="Joan Maragall 17"
        onAddressChange={onAddressChange}
        onAddressSelect={vi.fn()}
      />,
    );

    expect(await screen.findByText("search ready")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "Carrer Joan Maragall 17" },
    });

    expect(onAddressChange).toHaveBeenCalledWith("Carrer Joan Maragall 17");
  });
});
