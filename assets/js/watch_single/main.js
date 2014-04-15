jQuery(document).ready(function($) {
/*********************************
    JUST SETTING UP THE PAGE HERE
*********************************/
    // Initializing duckster gridster
    var gridsterWidth = $('.gridster').width();
    if ( gridsterWidth  < 600 ){
        // Mobile sized grids for single columns
        $(".gridster ul").gridster({
            widget_margins: [ gridsterWidth*0.027, gridsterWidth*0.027 ],
            widget_base_dimensions: [ gridsterWidth*0.2775, gridsterWidth*0.2775 ]
        });
    } else {
        // Desktop big screens for triple columns
        $(".gridster ul").gridster({
            widget_margins: [ gridsterWidth*0.009, gridsterWidth*0.009 ],
            widget_base_dimensions: [ gridsterWidth*0.0925, gridsterWidth*0.0925 ]
        });
    }

    // Initializes the bootstrap modals
    $('.modal#old-group').modal({ 
        show : false
    });
    
    $('.modal#rule-boilerplate').modal({
        show : false
    });

    $('.modal#component-breakdowns').modal({
        show : false
    });

    // Proceed to execute and save the group
    $('.btn#save-new-group').on('click', handlerCreateGroup);

    // Proceed to update the group
    $('.btn#update-old-group').on('click', handlerUpdateGroup);

    // Proceed to execute and delete the group
    $('.btn#delete-old-group').on('click', handlerDeleteGroup);

/*********************************
    SAVING NEW GROUPS AND QUERIES
*********************************/
    // Append a new HTML query template for the group
    var new_query_unique_counter = 0;
    $('.btn#new-query-template').click( function() {
        new_query_unique_counter++;
        var thisNum = new_query_unique_counter;
        $('.modal#new-group').find('form').append( templateNewGroup( thisNum ));

        // Initializing remove button for this new item
        $('button#remove-query').click(function(){
            $(this).closest('div.query').remove();
        });
        // Initializing colorpicker for this new item
        $(".colourpicker[id='"+thisNum+"']").spectrum({
            showInput: false,
            preferredFormat: 'hex6',
            clickoutFiresChange: true,
            showButtons: false,
            move: function(color) {
                $(".colourpicker[id='"+thisNum+"']").css( 'color', color.toHexString() );
            }
        });

        $('.quick-qb[id="'+thisNum+'"]').click(function(){
            var $this = $(this);
            quickQbmaker($this);
        });
    });

/*****************************************
    EDITING EXISTING GROUPS AND QUERIES
*****************************************/
    // Brings up the modal for adding a new group
    $('.btn#edit-old-group').click(function(){
        var groupID = $(this).data('group-id');
        var thisGroup = coreData.groups[groupID];

        // Clean up modal from prior viewing of existing groups
        $('.modal#old-group').find('div.old-query').remove();

        // Setting the values inside the modal's form fields
        $('.modal#old-group').find('input#group-name').val( thisGroup.title );

        if ( thisGroup.is_plot ) {
            $('.modal#old-group').find('input#group-is-plot').prop( "checked", true );
        } else {
            $('.modal#old-group').find('input#group-is-plot').prop( "checked", false );
        }

        if ( thisGroup.is_number ) {
            $('.modal#old-group').find('input#group-is-number').prop( "checked", true );
        } else {
            $('.modal#old-group').find('input#group-is-number').prop( "checked", false );
        }
        
        $.each( thisGroup.queries, function( key, value ){
            if ( value.is_reference ){
                setTimeout(function(){
                    $('.modal#old-group').find('div.old-query#q'+value.ref_query).find('select#old-query-reference option[value="'+value.ref_version+'"]').prop("selected", true);
                }, 100);
            } else {
                // Append the html for each query
                $('.modal#old-group').find('form').append( templateOldGroup( key, value ) );
                
                // Initializing colorpicker for this new item
                $(".colourpicker[id='q"+key+"']").spectrum({
                    showInput: false,
                    preferredFormat: 'hex6',
                    clickoutFiresChange: true,
                    showButtons: false,
                    move: function(color) {
                        $(".colourpicker[id='q"+key+"']").css( 'color', color.toHexString() );
                    }
                });
            }
        });

        $('.btn#delete-old-group').data( 'group-id', groupID );
        $('.btn#update-old-group').data( 'group-id', groupID );
        // End of setting values in the modal form

        // Fields are populated and disabled. Show modal.
        $('.modal#old-group').modal('toggle');
    });

/*********************************
    GETTING THE RULES BOILERPLATE FOR GROUP
*********************************/
    // Brings up the modal with the rules boilerplate
    $('.btn#get-rule-boilerplate').click(function(){
        var groupID = $(this).data('group-id');
        
        // Setting up the rule boilerplate modal
        $('span#rule-group-title').html( coreData.groups[groupID].title );
        $('.form-control-static#rule-file-name').html( '/assets/rules/rule_'+groupID+'.js' );
        $('textarea#rule-script').html( templateRuleBoilerplate( groupID ) );
        // End of setting up the rule boilerplate modal

        $('.modal#rule-boilerplate').modal('toggle');
    });

/*********************************
    GETTING THE COMPONENT BREAKDOWN FOR GROUP
*********************************/
    var breakdown_groupID ;
    // Brings up the modal with the component breakdowns
    $('.btn#get-component-breakdowns').click(function(){
        var groupID = $(this).data('group-id');
        breakdown_groupID = groupID
        // Setting up the component breakdown modal
        $('span#breakdown-group-title').html( coreData.groups[groupID].title );
        $('.breakdown-graph .breakdown-y-axis').html('');
        $('.breakdown-graph .breakdown-plot').html('');
        $('.breakdown-table').addClass('text-center').addClass('not-ready').html('<img src="/assets/img/mozchomp.gif"><div class="breakdown-loading">This may take a few minutes</div>');
        // End of setting up the component breakdown modal

        $('.modal#component-breakdowns').modal('toggle');
        
    });

    $('.modal#component-breakdowns').on('shown.bs.modal', function(e) {
        initializeBreakdown(breakdown_groupID);           
    });


    $('.modal#component-breakdowns').on('hidden.bs.modal', function(e) {
        $('span#breakdown-group-title').html('');
        $('.breakdown-graph .breakdown-y-axis').html('');
        $('.breakdown-graph .breakdown-plot').html('');
        $('.breakdown-table').removeClass('text-center').removeClass('not-ready').html('');               
    });

/*****************************
    HANDLING THE COMMENT MODAL FOR VERSION
*****************************/
    $('.btn#save-comment').click(function(){
        $this = $(this);
        $this.addClass('disabled');
        
        var r = confirm("Confirm saving this comment?");
        if ( r == true ) {
            $.ajax({
                url: '/api/comments',
                type: 'POST',
                data: {
                    version_id : coreData['id'],
                    version_comment : $('textarea.input-comment').val()
                },
                success: function(response) {
                    if ( response == 'OK' ) {
                        $this.html('<i class="fa fa-check"></i> Success');
                        setTimeout(function() {
                            // Refresh page after 1.5 seconds
                            $this.html('<i class="fa fa-refresh"></i> Refreshing');
                            location.reload();
                        }, 1500);
                    }

                    console.log(response);
                }, 
                error: function(response) {
                    alert('Fail: API could not be reached.');
                    $this.removeClass('disabled');
                    console.log(response);
                }
            });
        } else {
            $this.removeClass('disabled');               
        }
    });        
});
