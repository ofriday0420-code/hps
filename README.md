# HPS Custom Print & Design

HPS is a custom-printing storefront prototype for Bangladesh. The current application is intentionally kept as a lightweight browser prototype while the production architecture is built in vertical slices.

## Current build

Phase 1 has established the first brand and design-system layer:

- Responsive HPS brand header and navigation
- Accessible skip link and keyboard focus states
- Mobile navigation drawer
- Conversion-focused homepage hero
- Product and design workflow preserved from the original prototype
- Responsive design tokens, cards, buttons and section hierarchy
- Existing Fabric.js customization, cart and order interactions preserved
- Structured product catalog with descriptions, categories and supported colors
- Product search and category/price filters
- Product detail panel connected to the Design Studio
- Live print-quality status with safe-area warnings
- Front/back artwork state with device-local save/load preparation

The implementation reference is [HPS_Custom_Print_Design_Final_Project_Implementation_Plan.pdf](./HPS_Custom_Print_Design_Final_Project_Implementation_Plan.pdf).

## Run locally

Open `index.html` in a modern browser. The current prototype loads Fabric.js from the CDN, so an internet connection is required for the design editor.

## Planned build sequence

1. Brand and design system
2. Storefront and product data
3. Reusable Design Studio module
4. Persistent cart and checkout
5. Backend, database and authentication
6. Payments, order management and production workflow
7. Security hardening, testing and deployment
