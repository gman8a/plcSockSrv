/*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 *      File: log_lib.js
 *    Author: Gary Argraves (GLA), Claude (Anthropic)
 *      Date: 2025-02-08 (original), refactored 2026-03-14
 *   Purpose: Flat-file logging library shared across all process control modules.
 *            Supports console, file, and combined (frontend) logging with automatic
 *            log file maintenance (age-based cleaning via awk_clean_log bash script).
 *     Usage: const log = require('./log_lib');
 *            log.set_moduleName('myModule');
 *            log.log_write_frontend('System started');
 *            log.log_write_console('Debug info');
 *            log.log_write_file('File-only entry');
 * 
 *  Features: - Flat-file logging via fs.createWriteStream (append mode)
 *            - Console + file combined logging (log_write_frontend)
 *            - Log file age-based cleaning (default 15 days, 60 for lowFreqScan)
 *            - Message caching during clean operation (no dropped entries)
 *            - Uncaught exception handler with drain-safe shutdown
 *            - Configurable root path and module name
 *            - Local timezone datetime stamp on all entries
 * 
 *   Company: My Industrial Controls (MIC)
 *- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - */
//--- BEGIN-OF-FILE: log_lib.js ---

'use strict';

var fs = require('fs');
var { spawn } = require('child_process');

//--- Module-level state
var rootPath      = '.';
var moduleName    = 'noModuleName';
var log_file_name = rootPath + '/logs/' + moduleName + '_log.txt';
var logger        = null;  // fs.WriteStream; set in set_moduleName()

//--- Log file cleaning control block
var clean_mode = {
    active_flag  : false,
    tmp_msg_arr  : [],
    log_period_days: '30',  // valid: '15', '20', '30', '60'
};

/*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @brief  Interval: test once per 10 min if log clean should trigger.
 *
 *   Fires between worker shift changes. Target window: 23:40–23:50 (11 PM).
 *   lowFreqScan modules get 60-day retention (they hold trend log entries).
 */
setInterval(function ()
{
    var now      = new Date();
    var hour     = now.getHours();
    var min      = now.getMinutes();
    var hourX    = 23;
    var min_low  = 40;
    var min_high = 50;

    if (hour === hourX && min >= min_low && min < min_high)
    {
        clean_mode.log_period_days = (/lowFreqScan/.test(moduleName)) ? '60' : '15';
        clean_file_log();
    }
},
    600000  // 10 minutes
);

/*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @brief  Remove log entries older than clean_mode.log_period_days.
 *
 *   Delegates to bash script awk_clean_log. Process takes 2–5 seconds
 *   depending on log file size. Messages arriving during clean are cached
 *   in clean_mode.tmp_msg_arr and flushed after re-open (Step 5).
 *
 *   Steps:
 *     1. Close current log stream
 *     2. Spawn awk_clean_log to trim old entries
 *     3. Re-open log stream on child exit
 *     4. Write clean-process metadata
 *     5. Flush cached messages
 */
function clean_file_log()
{
    clean_mode.active_flag = true;

    // STEP 1: close open log stream
    if (logger)
    {
        logger.end();
        logger.destroy();
    }

    // STEP 2: spawn bash cleaner
    var output = [];
    var bat = spawn('bash', ['awk_clean_log', rootPath, moduleName, clean_mode.log_period_days]);

    bat.stdout.on('data', function (data) { output.push(data.toString()); });
    bat.stderr.on('data', function (data) { output.push(data.toString()); });

    bat.on('exit', function (code)
    {
        output.push('Log Cleaner exited with code ' + code);

        // STEP 3: re-open log stream
        logger = fs.createWriteStream(log_file_name, { flags: 'a' });

        // STEP 4: write clean metadata marker
        logger.write('\n///Log file cleaning done; cached messages follow///\n');

        // STEP 5: flush messages cached during clean
        for (var i = 0; i < clean_mode.tmp_msg_arr.length; i++)
        {
            logger.write(clean_mode.tmp_msg_arr[i]);
        }
        logger.write('///End clean process///\n');

        clean_mode.active_flag  = false;
        clean_mode.tmp_msg_arr  = [];
    });
}//fn clean_file_log

/*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @brief  Internal write: cache during clean, otherwise write to stream.
 */
function logger_write(message)
{
    if (clean_mode.active_flag)
    {
        clean_mode.tmp_msg_arr.push(message);
        return;
    }
    if (logger !== null)
    {
        logger.write(message);
    }
}//fn logger_write

/*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @brief  Returns local datetime string with milliseconds and UTC offset.
 *         Format: YYYY/MM/DD HH:MM:SS.mmm,+offset
 */
function get_local_dateTime_str()
{
    var now      = new Date();
    var year     = now.getFullYear();
    var month    = ('0'  + (now.getMonth() + 1)).slice(-2);
    var day      = ('0'  + now.getDate()).slice(-2);
    var time     = now.toTimeString().slice(0, 8);
    var ms       = ('000' + now.getMilliseconds()).slice(-3);
    var tzOffset = now.getTimezoneOffset() / -60;

    return year + '/' + month + '/' + day + ' ' + time + '.' + ms + ',' + tzOffset;
}//fn get_local_dateTime_str

/*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @brief  Uncaught exception handler — last-resort safety net.
 *
 *   Writes to both node_break_trace.txt and the module log, then exits.
 *   Uses drain event for graceful flush; falls back to immediate exit.
 *   NOTE: Do not rely on this for recoverable errors. Use try/catch.
 *
 *   Ref: https://shapeshed.com/uncaught-exceptions-in-node/
 */
var fatal_err_log = rootPath + '/node_break_trace.txt';

process.on('uncaughtException', function (err)
{
    var stamp   = new Date().toLocaleString();
    var summary = '\n\n' + stamp + '  module: ' + moduleName +
                  ', err: ' + err.message + '\n' + err.stack;

    // Always write to break trace (sync — safe here)
    fs.appendFileSync(fatal_err_log, summary);

    // Best-effort write to module log
    logger_write('\n\n' + get_local_dateTime_str() +
                 ' uncaughtException: ' + err.message + '\n' + err.stack + '\n');

    if (logger !== null)
    {
        logger.on('drain', function () { process.exit(1); });
        logger.write('...drain then exit;\n');
        logger.end();
        // Belt-and-suspenders: drain sometimes does not fire if queue was empty
        setTimeout(function () { process.exit(1); }, 3000);
    }
    else
    {
        process.exit(1);
    }
});

/*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 *  Module exports
 */
module.exports = {

    /*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * @brief  Initialize module name and open the log file stream.
     *         Must be called before any log_write_* functions.
     */
    set_moduleName: function (name)
    {
        moduleName    = name;
        log_file_name = rootPath + '/logs/' + moduleName + '_log.txt';
        logger        = fs.createWriteStream(log_file_name, { flags: 'a' });
    },//fn

    /*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * @brief  Returns local datetime string (exposed for callers).
     */
    get_local_dateTime_str: function ()
    {
        return get_local_dateTime_str();
    },//fn

    /*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * @brief  Write message to console only, prefixed with timestamp + module.
     * @param  pMessage     {string}  Message text
     * @param  CR_LF_flag   {bool}    Prepend blank line if true
     */
    log_write_console: function (pMessage, CR_LF_flag)
    {
        CR_LF_flag = CR_LF_flag || false;
        var line = get_local_dateTime_str() + '  ' + moduleName + ' >' + pMessage;
        console.log(CR_LF_flag ? '\n' + line : line);
    },//fn

    /*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * @brief  Write message to both console and log file (standard call).
     * @param  pMessage     {string}  Message text
     * @param  plogServer   {bool}    Write to file if true (default: true)
     * @param  CR_LF_flag   {bool}    Prepend blank line if true
     */
    log_write_frontend: function (pMessage, plogServer, CR_LF_flag)
    {
        plogServer  = (plogServer  === undefined) ? true  : plogServer;
        CR_LF_flag  = (CR_LF_flag  === undefined) ? false : CR_LF_flag;
        this.log_write_console(pMessage, CR_LF_flag);
        this.log_write_file(pMessage, plogServer, CR_LF_flag);
    },//fn

    /*- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * @brief  Write message to flat log file only.
     * @param  pMessage     {string}  Message text
     * @param  plogServer   {bool}    Write to file if true (default: true)
     * @param  CR_LF_flag   {bool}    (unused; reserved for future use)
     */
    log_write_file: function (pMessage, plogServer, CR_LF_flag)
    {
        plogServer = (plogServer === undefined) ? true : plogServer;
        if (!plogServer) { return; }

        // Extra blank line on module restart entries for readability
        var restart_break = (/__ Starting __/.test(pMessage)) ? '\n\n' : '';

        try
        {
            logger_write(restart_break + '\n' + get_local_dateTime_str() + ' >' + pMessage);
        }
        catch (e)
        {
            console.error('ERROR log_write_file() msg: "' + pMessage + '" err: ' + e);
        }
    },//fn

};//exports

//--- END-OF-FILE: log_lib.js ---
