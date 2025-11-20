/**
 * Tests for getMockAIResponse function
 * This function does intelligent fuzzy matching between questions and userData
 */

// Simplified version of getMockAIResponse for testing
function getMockAIResponse(question, userData, options) {
  if (!userData || Object.keys(userData).length === 0) {
    return '';
  }

  const lowerQuestion = question.toLowerCase();

  // Helper function to find best match in options
  // Uses same logic as findBestMatch in content.js
  function findInOptions(value, options) {
    if (!options || !value) return value;

    const answer = value.toString();
    const normalizedAnswer = answer.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
    const answerWords = normalizedAnswer.split(/\s+/).filter(w => w.length > 0);

    // PASS 1: Try exact match first
    for (const option of options) {
      if (option.toLowerCase() === answer.toLowerCase()) {
        return option;
      }
    }

    // PASS 2: Try substring match (prefer shorter/more specific)
    let substringMatch = null;
    for (const option of options) {
      const lowerOption = option.toLowerCase();
      const lowerAnswer = answer.toLowerCase();

      if (lowerOption.includes(lowerAnswer) || lowerAnswer.includes(lowerOption)) {
        if (!substringMatch || option.length < substringMatch.length) {
          substringMatch = option;
        }
      }
    }

    if (substringMatch) {
      return substringMatch;
    }

    // PASS 3: Word-based scoring
    let bestMatch = null;
    let maxScore = 0;

    for (const option of options) {
      const normalizedOption = option.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
      const optionWords = normalizedOption.split(/\s+/).filter(w => w.length > 0);

      const score = answerWords.filter(word => optionWords.includes(word)).length;

      if (score > maxScore) {
        maxScore = score;
        bestMatch = option;
      }
    }

    return bestMatch || value; // Return best match or original if no match
  }

  // Intelligent fuzzy matching in userData keys
  function findUserDataValue(keywords) {
    if (!Array.isArray(keywords)) keywords = [keywords];

    for (const keyword of keywords) {
      const lowerKeyword = keyword.toLowerCase();

      // Try exact match first
      for (const [key, value] of Object.entries(userData)) {
        if (key.toLowerCase() === lowerKeyword && value) {
          return value;
        }
      }

      // Try partial match
      for (const [key, value] of Object.entries(userData)) {
        const lowerKey = key.toLowerCase();
        if ((lowerKey.includes(lowerKeyword) || lowerKeyword.includes(lowerKey)) && value) {
          return value;
        }
      }
    }

    return null;
  }

  let answer = '';

  // Match question to userData
  if (lowerQuestion.includes('experience') || lowerQuestion.includes('doświadczenie') || lowerQuestion.includes('lata')) {
    answer = findUserDataValue(['experience', 'doświadczenie', 'yearsOfExperience', 'years', 'lata', 'lata doświadczenia']) || '';
  } else if (lowerQuestion.includes('education') || lowerQuestion.includes('wykształcenie')) {
    answer = findUserDataValue(['education', 'wykształcenie', 'edukacja', 'szkoła']) || '';
  } else if (lowerQuestion.includes('email') || lowerQuestion.includes('e-mail')) {
    answer = findUserDataValue(['email', 'e-mail', 'mail']) || '';
  } else if (lowerQuestion.includes('phone') || lowerQuestion.includes('telefon')) {
    answer = findUserDataValue(['telefon', 'phone', 'tel', 'numer telefonu']) || '';
  } else if (lowerQuestion.includes('country') || lowerQuestion.includes('kraj')) {
    answer = findUserDataValue(['country', 'kraj', 'państwo']) || '';
  } else if (lowerQuestion.includes('first name') || lowerQuestion.includes('imię')) {
    answer = findUserDataValue(['imię', 'firstName', 'first name']) || '';
  } else if (lowerQuestion.includes('last name') || lowerQuestion.includes('nazwisko')) {
    answer = findUserDataValue(['nazwisko', 'lastName', 'last name']) || '';
  }

  // If we have options, try to match answer to one of them
  if (options && options.length > 0 && answer) {
    answer = findInOptions(answer, options);
  }

  return answer;
}

describe('getMockAIResponse - Polish/English matching', () => {
  const polishUserData = {
    'Imię i nazwisko': 'Jan Kowalski',
    'Email': 'jan@example.com',
    'Telefon': '+48 123 456 789',
    'Wykształcenie': 'Wyższe',
    'Lata doświadczenia': '3-5 lat',
    'Kraj': 'Poland'
  };

  describe('Polish questions with Polish data', () => {
    test('should match "Wykształcenie" question', () => {
      const result = getMockAIResponse('Wykształcenie', polishUserData);
      expect(result).toBe('Wyższe');
    });

    test('should match "Lata doświadczenia" question', () => {
      const result = getMockAIResponse('Lata doświadczenia', polishUserData);
      expect(result).toBe('3-5 lat');
    });

    test('should match "Kraj" question', () => {
      const result = getMockAIResponse('Kraj', polishUserData);
      expect(result).toBe('Poland');
    });

    test('should match "Email" question', () => {
      const result = getMockAIResponse('Email', polishUserData);
      expect(result).toBe('jan@example.com');
    });

    test('should match "Telefon" question', () => {
      const result = getMockAIResponse('Telefon', polishUserData);
      expect(result).toBe('+48 123 456 789');
    });
  });

  describe('English questions with Polish data', () => {
    test('should match "Education level" to Polish "Wykształcenie"', () => {
      const result = getMockAIResponse('Education level', polishUserData);
      expect(result).toBe('Wyższe');
    });

    test('should match "Years of experience" to Polish "Lata doświadczenia"', () => {
      const result = getMockAIResponse('Years of experience', polishUserData);
      expect(result).toBe('3-5 lat');
    });

    test('should match "Country" to Polish "Kraj"', () => {
      const result = getMockAIResponse('Country', polishUserData);
      expect(result).toBe('Poland');
    });
  });

  describe('Options matching', () => {
    test('should match Polish answer to English options', () => {
      const options = ['1-2 years', '3-5 years', '5+ years'];
      const result = getMockAIResponse('Lata doświadczenia', polishUserData, options);
      expect(result).toBe('3-5 years');
    });

    test('should match "Wyższe" to expanded option', () => {
      const options = ['Podstawowe', 'Średnie', 'Wyższe - licencjat', 'Wyższe - magister'];
      const result = getMockAIResponse('Wykształcenie', polishUserData, options);
      // Should match first option containing 'Wyższe'
      expect(result).toContain('Wyższe');
    });

    test('should match country to country code option', () => {
      const options = ['United States (+1)', 'Poland (+48)', 'Germany (+49)'];
      const result = getMockAIResponse('Kraj', polishUserData, options);
      expect(result).toBe('Poland (+48)');
    });
  });

  describe('Edge cases', () => {
    test('should return empty string for no match', () => {
      const result = getMockAIResponse('Unknown question', polishUserData);
      expect(result).toBe('');
    });

    test('should return empty string for empty userData', () => {
      const result = getMockAIResponse('Email', {});
      expect(result).toBe('');
    });

    test('should handle question with asterisk', () => {
      const result = getMockAIResponse('Wykształcenie *', polishUserData);
      expect(result).toBe('Wyższe');
    });

    test('should handle question with extra spaces', () => {
      const result = getMockAIResponse('  Lata doświadczenia  ', polishUserData);
      expect(result).toBe('3-5 lat');
    });
  });

  describe('Real user data scenarios', () => {
    const englishUserData = {
      'firstName': 'John',
      'lastName': 'Smith',
      'email': 'john@example.com',
      'phone': '+1 555 1234',
      'education': 'Bachelor',
      'yearsOfExperience': '5+',
      'country': 'Poland'
    };

    test('should work with English userData keys', () => {
      expect(getMockAIResponse('Email', englishUserData)).toBe('john@example.com');
      expect(getMockAIResponse('Phone', englishUserData)).toBe('+1 555 1234');
      expect(getMockAIResponse('Education', englishUserData)).toBe('Bachelor');
      expect(getMockAIResponse('Experience', englishUserData)).toBe('5+');
    });

    test('should work with camelCase keys', () => {
      expect(getMockAIResponse('First name', englishUserData)).toBe('John');
      expect(getMockAIResponse('Years of experience', englishUserData)).toBe('5+');
    });
  });
});

describe('Batch processing simulation', () => {
  test('should handle multiple questions efficiently', () => {
    const userData = {
      'Email': 'test@example.com',
      'Telefon': '+48 123 456 789',
      'Wykształcenie': 'Wyższe',
      'Lata doświadczenia': '3-5 lat'
    };

    const questions = [
      { question: 'Email', options: null },
      { question: 'Telefon', options: null },
      { question: 'Wykształcenie', options: ['Podstawowe', 'Średnie', 'Wyższe'] },
      { question: 'Lata doświadczenia', options: ['1-2 lata', '3-5 lat', '5+ lat'] }
    ];

    const answers = questions.map(q => getMockAIResponse(q.question, userData, q.options));

    expect(answers[0]).toBe('test@example.com');
    expect(answers[1]).toBe('+48 123 456 789');
    expect(answers[2]).toBe('Wyższe');
    expect(answers[3]).toBe('3-5 lat');
  });

  test('should handle mixed Polish/English questions', () => {
    const userData = {
      'Imię': 'Jan',
      'email': 'jan@test.pl',
      'Wykształcenie': 'Wyższe',
      'yearsOfExperience': '5+'
    };

    expect(getMockAIResponse('First name', userData)).toBe('Jan');
    expect(getMockAIResponse('Email', userData)).toBe('jan@test.pl');
    expect(getMockAIResponse('Education level', userData)).toBe('Wyższe');
    expect(getMockAIResponse('Lata doświadczenia', userData)).toBe('5+');
  });
});
