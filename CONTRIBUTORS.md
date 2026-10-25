# Contributors

## Mcpasi

50 tests, including smoke tests, have been added under /tests: compression, UI, import, comparison, and downloads.

Start tests with `npm test` 

All 50 tests were successfully completed. 

Fixed: Removing an image during processing would permanently stall all other ongoing image tasks at the Compressing… stage.             
                                                   
- Reproduced prior to the fix: Three new      
  regression tests failed.
              
- Fix in js/app.js: Only the results for the    
  removed image are discarded, rather than    
  the entire batch.
                 
- Tests in tests/app.test.js: Verified handling 
  of successful completion, encoder errors,   
  and the removal of images that have already 
  finished processing.

[GitHub](https://github.com/Mcpasi)