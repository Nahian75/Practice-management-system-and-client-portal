import { Injectable } from '@nestjs/common';

export interface RedactionStats {
  niNumbersCount: number;
  cardsCount: number;
  sortCodesCount: number;
  bankAccountsCount: number;
  credentialsCount: number;
  dobsCount: number;
  totalRedactions: number;
}

export interface RedactionResult {
  redactedText: string;
  stats: RedactionStats;
}

@Injectable()
export class RedactionService {
  // UK National Insurance Number format (including HMRC test prefix QQ)
  private readonly niRegex = /\b(?:QQ|[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z])\s*\d{2}\s*\d{2}\s*\d{2}\s*[A-D]\b/gi;

  // Major payment card formats (Visa, MasterCard, Amex)
  private readonly cardRegex = /\b(?:\d{4}[ -]?){3}\d{4}\b|\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b/g;

  // UK Bank Sort Code (e.g., 12-34-56 or 12 34 56)
  private readonly sortCodeRegex = /\b\d{2}[- ]\d{2}[- ]\d{2}\b/g;

  // Bank Account Number (7-8 digits preceded by account identifier)
  private readonly bankAccountRegex = /\b(?:account|acct|acc|a\/c|no\.?)\s*[:#]?\s*(\d{7,8})\b/gi;

  // Passwords, tokens, API keys
  private readonly credentialRegex = /\b(password|passwd|api_key|secret_key|private_key|bearer)\s*[:=]\s*([^\s,;]+)/gi;

  // Explicit Date of Birth notation
  private readonly dobRegex = /\b(dob|date of birth|born)\s*[:=]?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/gi;

  redact(input: string): RedactionResult {
    let text = input;
    let niCount = 0;
    let cardCount = 0;
    let sortCodeCount = 0;
    let bankAccountCount = 0;
    let credentialCount = 0;
    let dobCount = 0;

    // 1. Redact NI numbers
    text = text.replace(this.niRegex, () => {
      niCount++;
      return '[REDACTED_NI_NUMBER]';
    });

    // 2. Redact payment cards
    text = text.replace(this.cardRegex, (match) => {
      // Discard false positives if it's just all zeros
      const digitsOnly = match.replace(/\D/g, '');
      if (digitsOnly.length < 13 || /^0+$/.test(digitsOnly)) {
        return match;
      }
      cardCount++;
      return '[REDACTED_CARD_NUMBER]';
    });

    // 3. Redact bank account numbers
    text = text.replace(this.bankAccountRegex, (match, digits) => {
      bankAccountCount++;
      return match.replace(digits, '[REDACTED_BANK_ACCOUNT]');
    });

    // 4. Redact sort codes
    text = text.replace(this.sortCodeRegex, () => {
      sortCodeCount++;
      return '[REDACTED_SORT_CODE]';
    });

    // 5. Redact credentials
    text = text.replace(this.credentialRegex, (match, _prefix, secret) => {
      credentialCount++;
      return match.replace(secret, '[REDACTED_CREDENTIAL]');
    });

    // 6. Redact explicit DOB mentions
    text = text.replace(this.dobRegex, (match, _prefix, date) => {
      dobCount++;
      return match.replace(date, '[REDACTED_DOB]');
    });

    const totalRedactions = niCount + cardCount + sortCodeCount + bankAccountCount + credentialCount + dobCount;

    return {
      redactedText: text,
      stats: {
        niNumbersCount: niCount,
        cardsCount: cardCount,
        sortCodesCount: sortCodeCount,
        bankAccountsCount: bankAccountCount,
        credentialsCount: credentialCount,
        dobsCount: dobCount,
        totalRedactions,
      },
    };
  }
}
