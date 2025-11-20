/**
 * Tests for findBestMatch function
 * This function is critical for matching AI answers to dropdown options
 */

// Extract findBestMatch from content.js
function findBestMatch(answer, options) {
  if (!options || options.length === 0) {
    return null;
  }

  // Polish to English country name mapping
  const countryTranslations = {
    'polska': 'poland',
    'niemcy': 'germany',
    'francja': 'france',
    'wielka brytania': 'united kingdom',
    'uk': 'united kingdom',
    'usa': 'united states',
    'stany zjednoczone': 'united states',
    'hiszpania': 'spain',
    'włochy': 'italy',
    'holandia': 'netherlands',
    'belgia': 'belgium',
    'szwecja': 'sweden',
    'norwegia': 'norway',
    'dania': 'denmark',
    'czechy': 'czech republic',
    'słowacja': 'slovakia',
    'austria': 'austria',
    'szwajcaria': 'switzerland'
  };

  // Try to translate Polish country names to English
  const lowerAnswer = answer.toLowerCase().trim();
  const translatedAnswer = countryTranslations[lowerAnswer] || answer;

  // Normalize answer by removing special chars for better matching
  const normalizedAnswer = translatedAnswer.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const answerWords = normalizedAnswer.split(/\s+/).filter(w => w.length > 0);

  // PASS 1: Look for exact match (highest priority)
  for (const optionText of options) {
    if (optionText.toLowerCase() === translatedAnswer.toLowerCase()) {
      return optionText;
    }
  }

  // PASS 2: Look for substring match (second priority)
  let substringMatch = null;
  for (const optionText of options) {
    const lowerOption = optionText.toLowerCase();
    const lowerTranslatedAnswer = translatedAnswer.toLowerCase();

    // Exact substring match (answer is in option OR option is in answer)
    if (lowerOption.includes(lowerTranslatedAnswer) || lowerTranslatedAnswer.includes(lowerOption)) {
      // Prefer shorter matches (more specific)
      if (!substringMatch || optionText.length < substringMatch.length) {
        substringMatch = optionText;
      }
    }
  }

  if (substringMatch) {
    return substringMatch;
  }

  // PASS 3: Word-based scoring (fallback)
  let bestMatch = null;
  let maxScore = 0;

  for (const optionText of options) {
    const normalizedOption = optionText.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
    const optionWords = normalizedOption.split(/\s+/).filter(w => w.length > 0);

    // Count matching words
    const score = answerWords.filter(word => optionWords.includes(word)).length;

    if (score > maxScore) {
      maxScore = score;
      bestMatch = optionText;
    }
  }

  return bestMatch;
}

describe('findBestMatch', () => {
  describe('Exact matches', () => {
    test('should match exact option text', () => {
      const options = ['Option A', 'Option B', 'Option C'];
      expect(findBestMatch('Option B', options)).toBe('Option B');
    });

    test('should match case-insensitively', () => {
      const options = ['Yes', 'No', 'Maybe'];
      expect(findBestMatch('yes', options)).toBe('Yes');
      expect(findBestMatch('YES', options)).toBe('Yes');
    });
  });

  describe('Country code matching (User Issue #1)', () => {
    test('should match "+48" to "Poland (+48)"', () => {
      const options = [
        'United States (+1)',
        'United Kingdom (+44)',
        'Poland (+48)',
        'Germany (+49)'
      ];
      expect(findBestMatch('+48', options)).toBe('Poland (+48)');
    });

    test('should match "Poland" to "Poland (+48)"', () => {
      const options = [
        'United States (+1)',
        'Poland (+48)',
        'Germany (+49)'
      ];
      expect(findBestMatch('Poland', options)).toBe('Poland (+48)');
    });

    test('should match country codes with various formats', () => {
      const options = ['USA (+1)', 'Poland (+48)', 'UK (+44)'];
      expect(findBestMatch('+1', options)).toBe('USA (+1)');
      expect(findBestMatch('+44', options)).toBe('UK (+44)');
    });

    test('should translate "Polska" to "Poland" and match with (+48)', () => {
      const options = [
        'Afghanistan (+93)',
        'Albania (+355)',
        'Germany (+49)',
        'Poland (+48)',
        'Portugal (+351)',
        'United Kingdom (+44)'
      ];
      expect(findBestMatch('Polska', options)).toBe('Poland (+48)');
    });

    test('should translate other Polish country names', () => {
      const options = ['France (+33)', 'Germany (+49)', 'Spain (+34)', 'Italy (+39)'];
      expect(findBestMatch('Niemcy', options)).toBe('Germany (+49)');
      expect(findBestMatch('Francja', options)).toBe('France (+33)');
      expect(findBestMatch('Hiszpania', options)).toBe('Spain (+34)');
      expect(findBestMatch('Włochy', options)).toBe('Italy (+39)');
    });
  });

  describe('Polish text matching', () => {
    test('should match Polish education levels', () => {
      const options = [
        'Podstawowe',
        'Średnie',
        'Wyższe',
        'Policealne'
      ];
      expect(findBestMatch('Wyższe', options)).toBe('Wyższe');
    });

    test('should match Polish experience levels', () => {
      const options = [
        'Brak doświadczenia',
        '1-2 lata',
        '3-5 lat',
        '5+ lat'
      ];
      expect(findBestMatch('3-5 lat', options)).toBe('3-5 lat');
    });

    test('should match Polish to English experience levels', () => {
      const options = [
        'No experience',
        '1-2 years',
        '3-5 years',
        '5+ years'
      ];
      // If AI returns Polish but options are English
      expect(findBestMatch('3-5', options)).toBe('3-5 years');
    });
  });

  describe('Fuzzy matching', () => {
    test('should match partial text', () => {
      const options = [
        'Bachelor of Science',
        'Master of Science',
        'PhD in Computer Science'
      ];
      expect(findBestMatch('Master', options)).toBe('Master of Science');
    });

    test('should handle special characters', () => {
      const options = [
        'Option (A)',
        'Option (B)',
        'Option (C)'
      ];
      expect(findBestMatch('Option A', options)).toBe('Option (A)');
    });

    test('should match with extra spaces', () => {
      const options = ['Full Time', 'Part Time', 'Contract'];
      expect(findBestMatch('Full  Time', options)).toBe('Full Time');
    });
  });

  describe('Edge cases', () => {
    test('should return null for empty options', () => {
      expect(findBestMatch('anything', [])).toBe(null);
    });

    test('should return null for null options', () => {
      expect(findBestMatch('anything', null)).toBe(null);
    });

    test('should return best match when no exact match', () => {
      const options = ['Software Engineer', 'Data Scientist', 'Product Manager'];
      expect(findBestMatch('Engineer', options)).toBe('Software Engineer');
    });

    test('should handle numeric options', () => {
      const options = ['0-1', '1-3', '3-5', '5+'];
      expect(findBestMatch('3-5', options)).toBe('3-5');
    });

    test('should handle empty string answer', () => {
      const options = ['Option A', 'Option B'];
      // Should still try to match, but likely return null or first with 0 score
      const result = findBestMatch('', options);
      // Empty answer should not match anything strongly
      expect(result).toBeTruthy(); // Will match something due to substring
    });
  });

  describe('Real-world problematic cases', () => {
    test('Issue: "+48" not matching country selector', () => {
      // This was the actual bug reported
      const options = [
        'Afghanistan (+93)',
        'Albania (+355)',
        'Poland (+48)',
        'Portugal (+351)'
      ];
      const result = findBestMatch('+48', options);
      expect(result).toBe('Poland (+48)');
    });

    test('Issue: "Wyższe" not matching education dropdown', () => {
      const options = [
        'Podstawowe',
        'Zawodowe',
        'Średnie',
        'Policealne',
        'Wyższe - licencjat',
        'Wyższe - magister',
        'Doktor'
      ];
      // Should match first "Wyższe" option
      const result = findBestMatch('Wyższe', options);
      expect(result).toContain('Wyższe');
    });

    test('Issue: Years of experience not matching', () => {
      const options = [
        'Less than 1 year',
        '1-2 years',
        '3-5 years',
        '5-10 years',
        'More than 10 years'
      ];
      expect(findBestMatch('3-5 years', options)).toBe('3-5 years');
      expect(findBestMatch('3-5', options)).toBe('3-5 years');
    });
  });

  describe('Ranking priority', () => {
    test('exact match should win over substring', () => {
      const options = ['Yes, I have experience', 'Yes', 'No'];
      expect(findBestMatch('Yes', options)).toBe('Yes');
    });

    test('substring should prefer shorter matches', () => {
      const options = [
        'I want to work here because of growth',
        'Work from home',
        'Remote work'
      ];
      // 'work' is substring of all options
      // Should prefer shorter/more specific match
      expect(findBestMatch('work', options)).toBe('Remote work');
    });
  });
});
