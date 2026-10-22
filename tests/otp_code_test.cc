// Checks ExtractOtpCode, TypedStreamText and the Mail helpers (EmlxText, MimeText) (src/otp_code.h). Run: scripts/test-otp-code.sh
#include <cassert>
#include <cstdio>
#include <string>

#include "otp_code.h"

using roar::ExtractOtpCode;
using roar::TypedStreamText;
using roar::EmlxText;
using roar::MimeText;

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
  // Mail: plain, subject-only, quoted-printable, base64, HTML, multipart, emlx wrapper.
  assert(ExtractOtpCode(MimeText("Subject: Hi\nFrom: a@b.c\n\nYour verification code is 314159.\n")) == "314159");
  assert(ExtractOtpCode(MimeText("Subject: 271828 is your login code\n\nSee subject.\n")) == "271828");
  assert(ExtractOtpCode(MimeText("Subject: =?UTF-8?B?Q29kZTogNjY3Nzg4?=\n\nhi\n")) == "667788");
  assert(ExtractOtpCode(MimeText("Subject: x\nContent-Type: text/plain\nContent-Transfer-Encoding: quoted-printable\n\nYour sign-in co=\nde is 4=\n0 41 ok? no: code=3D 902211\n")) == "902211");
  assert(ExtractOtpCode(MimeText("Subject: x\nContent-Type: text/plain\nContent-Transfer-Encoding: base64\n\nWW91ciBj\nb2RlIGlzIDU1NjY3Nw==\n")) == "556677");
  assert(ExtractOtpCode(MimeText("Subject: x\nContent-Type: text/html; charset=utf-8\n\n<html><style>.c{color:#123456}</style><p>Your code&nbsp;is <b>123456</b></p></html>")) == "123456");
  std::string multi = "Subject: Sign in\nContent-Type: multipart/alternative;\n boundary=\"BoUnD\"\n\n--BoUnD\nContent-Type: text/plain\n\nhello\n--BoUnD\nContent-Type: text/html\nContent-Transfer-Encoding: quoted-printable\n\n<td style=3D\"x\">Verification code</td><td>8=\n04412</td>\n--BoUnD--\n";
  assert(ExtractOtpCode(MimeText(multi)) == "804412");
  std::string eml = "Subject: Code\r\n\r\nYour code is 7070\r\n";
  assert(ExtractOtpCode(EmlxText(std::to_string(eml.size()) + "\n" + eml + "<?xml version=\"1.0\"?><plist>12345678</plist>")) == "7070");
  // False positives: an order number and a price in a promo code mail.
  assert(ExtractOtpCode(MimeText("Subject: Order 5551-2200 shipped\n\nOrder 4455-6677 total $1299.00. Use promo code later.\n")) == "");
  assert(ExtractOtpCode(MimeText("Subject: Receipt\nContent-Type: text/html\n\n<p>Total: <b>$4500</b></p>")) == "");
  // Malformed MIME: no crash, no code.
  assert(MimeText("no headers at all") == "");
  assert(ExtractOtpCode(MimeText("Subject: x\nContent-Type: multipart/mixed; boundary=zz\n\n--zz\n")) == "");
  assert(EmlxText("") == "" && EmlxText("12") == "");
  std::puts("otp_code ok");
}
