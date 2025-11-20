# Test Suite - Wtyczka Chrome Extension

## Automated testing for form filling functionality

This test suite helps catch bugs before manual testing, saving time and preventing regressions.

## Running Tests

```bash
# Install dependencies (first time only)
npm install

# Run all tests
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Test Files

### Unit Tests

- **`findBestMatch.test.js`** - Tests for option matching algorithm
  - Exact matches
  - Country code matching ("+48" → "Poland (+48)")
  - Polish/English text matching
  - Fuzzy matching
  - Real-world problematic cases

- **`mockMatching.test.js`** - Tests for userData to question matching
  - Polish question → Polish userData
  - English question → Polish userData
  - Options matching
  - Batch processing simulation

### Manual Testing

- **`test-form.html`** - Complete test form with all problematic field types
  - Open in Chrome and load the extension
  - Click the extension icon to auto-fill
  - Verify all fields are filled correctly

## Test Form Fields

The `test-form.html` includes all problematic cases reported by users:

1. **SELECT dropdowns**
   - "Lata doświadczenia" (Years of experience)
   - "Wykształcenie" (Education level)
   - "Country/Region Code" with "+48" format

2. **Custom dropdowns** (button[aria-haspopup="dialog"])
   - "Kraj" (Country) selector

3. **Radiogroups**
   - Gender selection

4. **File inputs**
   - CV upload
   - Custom attachment button

5. **Text fields**
   - Email, Phone
   - Motivation textarea

## Expected Behavior

When running the extension on `test-form.html`:

1. All SELECTs should be filled with matching options
2. Custom "Kraj" dropdown should open and select correct country
3. "+48" should match "Poland (+48)" in country code SELECT
4. Polish answers should match English options (e.g., "3-5 lat" → "3-5 lat")
5. No fields should be marked as processed if filling failed
6. Second pass should retry any missed fields

## Adding New Tests

When fixing a bug:

1. Add a test case that reproduces the bug
2. Verify the test fails
3. Fix the bug
4. Verify the test passes
5. Commit both the fix and the test

Example:
```javascript
test('should match new problematic case', () => {
  const options = ['Option A', 'Option B'];
  expect(findBestMatch('answer', options)).toBe('Option A');
});
```

## Coverage

Run `npm run test:coverage` to see which code is tested:

- **content.js** - Form filling logic
- **ai.js** - AI and mock response matching
- **learning.js** - Learning system (future tests)

## Common Issues

**Tests failing with "Cannot find module"?**
- Run `npm install` to install dependencies

**Tests pass but extension doesn't work?**
- Tests use simplified versions of functions
- Always verify with manual test on `test-form.html`
- Check browser console for actual errors

**Want to test specific functionality?**
```bash
# Test only findBestMatch
npm test -- findBestMatch

# Test only mockMatching
npm test -- mockMatching
```
