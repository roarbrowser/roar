// Checks ExtractOtpCode and TypedStreamText (src/otp_code.h). Run: scripts/test-otp-code.sh
#include <cassert>
#include <cstdio>
#include <string>

#include "otp_code.h"

using roar::ExtractOtpCode;
using roar::TypedStreamText;

int main() {
  assert(ExtractOtpCode("Your verification code is 482913.") == "482913");
  assert(ExtractOtpCode("G-123456 is your Google verification code.") == "123456");
  assert(ExtractOtpCode("123456 is your Amazon OTP. Don't share it.") == "123456");
  assert(ExtractOtpCode("Your Chase one-time passcode is 7781. Call 800-555-1234 if not you.") == "7781");
  assert(ExtractOtpCode("In 2026 your code: 9921") == "9921");
  assert(ExtractOtpCode("Lunch at 1230? Bring $4000") == "");  // No code word.
  assert(ExtractOtpCode("Your code is 12") == "");             // Too short.
  assert(ExtractOtpCode("Code 123456789") == "");              // Too long.
  assert(ExtractOtpCode("Your order total is $1234.50, code later") == "");
  // A typedstream-like blob: ... NSString 01 94 84 01 '+' <len> <text> ...
  std::string text = "Your code is 5512";
  static const char kHead[] = "\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+";
  std::string blob(kHead, sizeof kHead - 1);
  blob += static_cast<char>(text.size()) + text + "\x86\x84\x02iI";
  assert(TypedStreamText(blob) == text);
  assert(ExtractOtpCode(TypedStreamText(blob)) == "5512");
  std::string long_text(300, 'a');
  std::string blob2 = std::string("NSString\x01\x94\x84\x01+\x81", 14) + static_cast<char>(300 & 0xff) + static_cast<char>(300 >> 8) + long_text;
  assert(TypedStreamText(blob2) == long_text);
  assert(TypedStreamText("garbage") == "");
  std::puts("otp_code ok");
}
