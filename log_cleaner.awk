#- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
#      File: log_cleaner.awk
#    Author: Gary Argraves (GLA), Claude (Anthropic)
#      Date: 2017-07-24 (original), refactored 2026-03-14
#   Purpose: Filter a flat module log file, emitting only records dated within
#            the last log_period_days days. Records without a dateline (blank
#            lines, continuation lines, stack traces) are preserved once the
#            first in-window record is found, maintaining log readability.
#     Usage: gawk -v nowDate="Tue 07/25/2017" -v log_period_days=30 \
#                 -f log_cleaner.awk <inFile> > <outFile>
#  Features: - Julian day conversion for reliable cross-month/year arithmetic
#            - keep_remaining_rec_flag preserves non-dated lines (stack traces,
#              blank spacers) once the retention window is entered
#            - Handles Jan/Feb month wrap (Gregorian->Julian correction)
#            - Two-digit year expansion: <80 -> 2000+, else -> 1900+
#
#  Input record format (dateline):
#      2025/07/24 12:25:55.167,-5 >SomeMessage
#
#  References:
#      https://quasar.as.utexas.edu/BillInfo/JulianDatesG.html
#      https://craftofcoding.files.wordpress.com/2013/07/cs_langjuliandates.pdf
#- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
#--- BEGIN-OF-FILE: log_cleaner.awk ---

BEGIN {
    RS  = "\n";   ORS = "\n"
    FS  = " ";    OFS = " "

    # nowDate arrives as: "Tue 07/25/2017"
    # Parse into MM/DD/YYYY then convert to Julian day for arithmetic.
    split(nowDate, nd_parts, " ")       # nd_parts[2] = "07/25/2017"
    split(nd_parts[2], md, "/")         # md[1]=MM  md[2]=DD  md[3]=YYYY

    # ToJul expects DD.MM.YYYY
    now_jul_day     = ToJul(md[2] "." md[1] "." md[3])
    oldest_jul_day  = now_jul_day - strtonum(log_period_days)

    # Once the first in-window record is found, all subsequent records are kept.
    # This preserves:
    #   1) Blank spacer lines
    #   2) Multi-line node uncaught-exception stack traces (no dateline per line)
    keep_remaining_rec_flag = 0
}

#--- Match records that begin with a dateline: 2025/07/24 ...
/^20[1-9][0-9]\/[0-9]?[0-9]\/[0-9]?[0-9] / {
    if (!keep_remaining_rec_flag) {
        split($1, d, "/")               # d[1]=YYYY  d[2]=MM  d[3]=DD
        jul_day = ToJul(d[3] "." d[2] "." d[1])
        if (jul_day > oldest_jul_day) {
            keep_remaining_rec_flag = 1
        }
    }
}

#--- Match every record (dateline or not)
{
    if (keep_remaining_rec_flag) {
        print $0
    }
}

END {
    # no end routine
}

#- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
# @brief  ToJul — Gregorian calendar date to Julian Day number.
#
# @param  date     String in DD.MM.YYYY format
# @return          Integer Julian Day number
#
# Algorithm (Gregorian):
#   Jan and Feb are treated as months 13 and 14 of the prior year.
#   A = Y/100
#   B = A/4
#   C = 2-A+B          (Gregorian reform correction)
#   E = 365.25*(Y+4716)
#   F = 30.6001*(M+1)
#   JD = C + D + E + F - 1524.5   (fractional parts dropped throughout)
#- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
function ToJul(date,    datum, lday, lmonth, lyear, fr_y, reform, jul_day)
{
    split(date, datum, ".")
    lday   = strtonum(datum[1])
    lmonth = strtonum(datum[2])
    lyear  = strtonum(datum[3])

    # Two-digit year expansion
    if      (lyear < 80)  lyear += 2000
    else if (lyear < 100) lyear += 1900

    # Jan/Feb belong to the prior year in Julian arithmetic
    if (lmonth < 3) {
        lyear  -= 1
        lmonth += 12
    }

    fr_y    = int(lyear / 100)
    reform  = 2 - fr_y + int(fr_y / 4)
    jul_day = lday + int(365.25 * (lyear + 4716)) \
                   + int(30.6001 * (lmonth + 1))  \
                   + reform - 1524

    return jul_day
}

#--- END-OF-FILE: log_cleaner.awk ---
